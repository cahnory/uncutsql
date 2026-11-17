// Compile-only regression checks: no casts should hide lost error/service inference.
import { Context, Data, Effect } from "effect";
import {
  type Codec,
  type Value,
  EncodeError,
  ParseError,
  document,
  literal,
  make,
  optional,
  prefixed,
  repeat,
  struct,
  taggedUnion,
  transform,
  transformEffect,
  tuple,
} from "../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<A extends true> = A;
class Settings extends Context.Service<Settings, { readonly enabled: boolean }>()(
  "typecheck/Settings",
) {}
class CustomError extends Data.TaggedError("CustomError")<{}> {}
const custom: Codec<"x", CustomError, Settings> = make<"x", CustomError, Settings>({
  decode: (cursor) =>
    Effect.gen(function* () {
      yield* Settings;
      return yield* literal("x").decode(cursor);
    }),
  encode: literal("x").encode,
});
const composed = document(struct({ value: custom, tail: optional(repeat(custom)) }));
type _Requirements = Assert<Equal<Effect.Services<ReturnType<typeof composed.decode>>, Settings>>;
type _DecodeErrors = Assert<
  Equal<Effect.Error<ReturnType<typeof composed.decode>>, ParseError | CustomError>
>;
type _EncodeErrors = Assert<
  Equal<Effect.Error<ReturnType<typeof composed.encode>>, EncodeError | CustomError>
>;
type _Tuple = Assert<
  Equal<
    Value<ReturnType<typeof tuple<readonly [typeof custom, typeof custom]>>>,
    readonly ["x", "x"]
  >
>;

const effectful = transformEffect(literal("x"), {
  decode: () => Effect.succeed(1),
  encode: (_value: number) =>
    Effect.gen(function* () {
      yield* Settings;
      return yield* Effect.fail(new CustomError());
    }),
});
const effectfulDocument = document(effectful);
type _TransformRequirements = Assert<
  Equal<Effect.Services<ReturnType<typeof effectfulDocument.encode>>, Settings>
>;
type _TransformErrors = Assert<
  Equal<Effect.Error<ReturnType<typeof effectfulDocument.encode>>, EncodeError | CustomError>
>;

const marker = transform(literal("x"), {
  decode: () => ({ _tag: "X" as const }),
  encode: (_value: { readonly _tag: "X" }) => "x" as const,
});
// @ts-expect-error Union member key must agree with its semantic tag.
taggedUnion({ Y: marker });
// @ts-expect-error Required service cannot disappear through composition.
const _withoutServices: Effect.Effect<unknown, unknown> = composed.decode("x");
// @ts-expect-error Prefix syntax must not discard a semantic string.
prefixed(literal("x"), literal("y"));
