import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Data, Effect, Exit, Layer, Logger, References, Result } from "effect";
import {
  type Codec, EncodeError, ParseError, alternatives, commit, document, literal, located,
  make, observe, optional, prefixed, read, repeat, struct, taggedUnion, transform,
  transformEffect, tuple,
} from "../src/codec/index.ts";

const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const syntax = (text: string): Codec<void> => transform(literal(text), {
  decode: (): void => undefined,
  encode: () => text,
});

test("tuple, struct and inverse transforms compose both directions", () => {
  const codec = document(struct({ left: literal("a"), right: tuple([literal("b"), literal("c")]) }));
  const value = Effect.runSync(codec.decode("abc"));
  assert.deepEqual(value, { left: "a", right: ["b", "c"] });
  assert.equal(Effect.runSync(codec.encode(value)), "abc");
});

test("failed alternatives roll back consumed input and source nodes", () => {
  const branch = (ending: string) => transform(tuple([located("prefix", literal("a")), literal(ending)]), {
    decode: () => "matched",
    encode: (_value: string) => ["a", ending] as const,
  });
  const codec = document(alternatives(branch("x"), branch("b")));
  const parsed = Effect.runSync(codec.decodeWithSourceMap("ab"));
  assert.equal(parsed.value, "matched");
  assert.equal(parsed.sourceMap.length, 1);
  assert.equal(parsed.sourceMap[0]!.kind, "prefix");
});

test("alternatives retain the furthest error and merge tied expectations", () => {
  const branch = (parts: readonly string[]) => transform(tuple(parts.map(literal)), {
    decode: () => "matched",
    encode: (_value: string) => parts,
  });
  const codec = document(alternatives(branch(["a", "b", "x"]), branch(["a", "b", "y"]), branch(["z"])));
  const error = failure(codec.decode("ab!"));
  assert.equal(error.offset, 2);
  assert.deepEqual(error.expected, ['"x"', '"y"']);
});

test("explicit commitment prevents fallback and optional recovery", () => {
  let fallbackRuns = 0;
  const first = transform(prefixed(syntax("a"), literal("b")), {
    decode: () => "first",
    encode: (_value: string) => "b" as const,
  });
  const fallback = make<string>({
    decode: (cursor) => {
      fallbackRuns++;
      return Effect.succeed(read("fallback", { ...cursor, offset: cursor.source.length }));
    },
    encode: () => Effect.succeed("ac"),
  });
  const error = failure(document(optional(alternatives(first, fallback))).decode("ac"));
  assert.equal(error.committed, true);
  assert.equal(error.offset, 1);
  assert.equal(fallbackRuns, 0);
});

test("optional restores the starting cursor after an uncommitted partial match", () => {
  const codec = document(tuple([optional(tuple([literal("a"), literal("x")])), literal("a")]));
  assert.deepEqual(Effect.runSync(codec.decode("a")), [undefined, "a"]);
});

test("repetition handles empty input, minimum length and dangling separators", () => {
  const codec = document(repeat(literal("a"), { separator: syntax(",") }));
  assert.deepEqual(Effect.runSync(codec.decode("")), []);
  assert.deepEqual(Effect.runSync(codec.decode("a,a")), ["a", "a"]);
  assert.equal(Effect.runSync(codec.encode(["a", "a"])), "a,a");
  assert.equal(failure(codec.decode("a,")).committed, true);
  const required = document(repeat(literal("a"), { min: 2, separator: syntax(",") }));
  assert.ok(failure(required.decode("a")) instanceof ParseError);
  assert.ok(failure(required.encode(["a"])) instanceof EncodeError);
});

test("zero-width repetition is rejected instead of looping forever", () => {
  const error = failure(document(repeat(literal(""))).decode(""));
  assert.equal(error.committed, true);
  assert.match(error.message, /consumes input/);
  assert.ok(failure(repeat(literal("")).encode([""])) instanceof EncodeError);
});

test("tagged unions dispatch encoding directly to the matching member", () => {
  const a = transform(literal("a"), {
    decode: () => ({ _tag: "A" as const }),
    encode: (_: { readonly _tag: "A" }) => "a" as const,
  });
  const b = transform(literal("b"), {
    decode: () => ({ _tag: "B" as const }),
    encode: (_: { readonly _tag: "B" }) => "b" as const,
  });
  const codec = document(taggedUnion({ A: a, B: b }));
  assert.deepEqual(Effect.runSync(codec.decode("b")), { _tag: "B" });
  assert.equal(Effect.runSync(codec.encode({ _tag: "B" })), "b");
  // Runtime defense for callers bypassing TypeScript, such as a JS consumer.
  // @ts-expect-error Unknown AST tag.
  assert.ok(failure(codec.encode({ _tag: "toString" })) instanceof EncodeError);
});

test("full input is required and errors report CRLF-aware positions", () => {
  const error = failure(document(literal("a\r\nb")).decode("a\r\nb?"));
  assert.deepEqual([error.offset, error.line, error.column], [4, 2, 2]);
  assert.deepEqual(error.expected, ["end of input"]);
});

class Policy extends Context.Service<Policy, { readonly allow: boolean }>()("tests/Policy") {}
class PolicyDenied extends Data.TaggedError("PolicyDenied")<{}> {}

const checked = transformEffect(literal("a"), {
  decode: (value) => Effect.gen(function* () {
    const policy = yield* Policy;
    if (!policy.allow) return yield* Effect.fail(new PolicyDenied());
    return value;
  }),
  encode: (value: "a") => Effect.succeed(value),
});

test("custom requirements propagate through composition and are supplied by a Layer", () => {
  const codec = document(struct({ value: checked, rest: repeat(checked) }));
  const program = codec.decode("aaa").pipe(Effect.provide(Layer.succeed(Policy, { allow: true })));
  assert.deepEqual(Effect.runSync(program), { value: "a", rest: ["a", "a"] });
});

test("optional, alternatives, commit and repetition never swallow service failures", () => {
  const check = <A>(codec: Codec<A, PolicyDenied, Policy>) => {
    const error = failure(document(codec).decode("a").pipe(
      Effect.provideService(Policy, { allow: false }),
    ));
    assert.ok(error instanceof PolicyDenied);
  };
  check(optional(checked));
  check(alternatives(checked, literal("a")));
  check(repeat(checked));
  check(commit(checked));
});

test("defects bypass parse recovery", () => {
  const broken = make<string>({ decode: () => Effect.die("broken codec"), encode: () => Effect.succeed("") });
  const exit = Effect.runSync(Effect.exit(document(optional(broken)).decode("")));
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit.cause), /broken codec/);
});

test("callbacks are lazy and reused effects do not reuse parse state", () => {
  let calls = 0;
  const counted = make({
    decode: (cursor) => { calls++; return literal("a").decode(cursor); },
    encode: literal("a").encode,
  });
  const effect = document(counted).decode("a");
  assert.equal(calls, 0);
  assert.equal(Effect.runSync(effect), "a");
  assert.equal(Effect.runSync(effect), "a");
  assert.equal(calls, 2);
});

test("one codec can parse concurrently across actual asynchronous boundaries", async () => {
  const delayed = make({
    decode: (cursor) => Effect.yieldNow.pipe(Effect.andThen(literal("a").decode(cursor))),
    encode: literal("a").encode,
  });
  const codec = document(repeat(delayed));
  const inputs = Array.from({ length: 30 }, (_, index) => "a".repeat(index));
  const outputs = await Effect.runPromise(Effect.all(inputs.map(codec.decode), { concurrency: "unbounded" }));
  assert.deepEqual(outputs.map((values) => values.length), inputs.map((input) => input.length));
});

test("observability composes with a caller-provided logger and annotations", () => {
  const events: { message: unknown; annotations: Readonly<Record<string, unknown>> }[] = [];
  const logger = Logger.make((options) => {
    events.push({ message: options.message, annotations: options.fiber.getRef(References.CurrentLogAnnotations) });
  });
  const codec = document(observe("test.literal", literal("a")));
  const program = Effect.gen(function* () {
    const value = yield* codec.decode("a");
    return yield* codec.encode(value);
  }).pipe(
    Effect.annotateLogs({ request: "test-1" }),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(Logger.layer([logger])),
  );
  assert.equal(events.length, 0);
  assert.equal(Effect.runSync(program), "a");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.annotations.operation), ["decode", "encode"]);
  assert.ok(events.every((event) => event.annotations.request === "test-1" && event.annotations.codec === "test.literal"));
});
