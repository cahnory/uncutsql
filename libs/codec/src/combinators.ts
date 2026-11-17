import { Effect, Result } from "effect";
import {
  type AnyCodec,
  type Codec,
  type Errors,
  type Read,
  type Requirements,
  type SourceNode,
  type Value,
  EncodeError,
  ParseError,
  commitError,
  make,
  mergeErrors,
  parseError,
  read,
} from "./model.ts";

export const literal = <const S extends string>(text: S): Codec<S> =>
  make({
    decode: (cursor) =>
      cursor.source.startsWith(text, cursor.offset)
        ? Effect.succeed(read(text, { ...cursor, offset: cursor.offset + text.length }))
        : Effect.fail(parseError(cursor, JSON.stringify(text))),
    encode: (value) =>
      value === text
        ? Effect.succeed(text)
        : Effect.fail(new EncodeError({ message: `Expected ${JSON.stringify(text)}` })),
  });

export const transform = <A, B, E, R>(
  codec: Codec<A, E, R>,
  mapping: { readonly decode: (value: A) => B; readonly encode: (value: B) => A },
): Codec<B, E, R> =>
  make({
    decode: (cursor) =>
      Effect.map(codec.decode(cursor), (result) => ({
        ...result,
        value: mapping.decode(result.value),
      })),
    encode: (value) => codec.encode(mapping.encode(value)),
  });

export const transformEffect = <A, B, E, R, E2, R2, E3, R3>(
  codec: Codec<A, E, R>,
  mapping: {
    readonly decode: (value: A) => Effect.Effect<B, E2, R2>;
    readonly encode: (value: B) => Effect.Effect<A, E3, R3>;
  },
): Codec<B, E | E2 | E3, R | R2 | R3> =>
  make<B, E | E2 | E3, R | R2 | R3>({
    decode: (cursor) =>
      Effect.flatMap(codec.decode(cursor), (result) =>
        Effect.map(mapping.decode(result.value), (value) => ({ ...result, value })),
      ),
    encode: (value) => Effect.flatMap(mapping.encode(value), codec.encode),
  });

export const tuple = <const C extends readonly AnyCodec[]>(
  codecs: C,
  separator = "",
): Codec<{ readonly [K in keyof C]: Value<C[K]> }, Errors<C[number]>, Requirements<C[number]>> => {
  type Values = { readonly [K in keyof C]: Value<C[K]> };
  // The loop erases heterogeneous members; all casts stay at this boundary.
  return make({
    decode: (start) =>
      Effect.gen(function* () {
        let next = start;
        const values: unknown[] = [];
        const nodes: SourceNode[] = [];
        for (const codec of codecs) {
          const result = yield* codec.decode(next);
          values.push(result.value);
          nodes.push(...result.nodes);
          next = result.next;
        }
        return read(values as Values, next, nodes);
      }) as Effect.Effect<Read<Values>, ParseError | Errors<C[number]>, Requirements<C[number]>>,
    encode: (values) =>
      Effect.gen(function* () {
        if (!Array.isArray(values) || values.length !== codecs.length) {
          return yield* Effect.fail(
            new EncodeError({ message: `Expected ${codecs.length} tuple elements` }),
          );
        }
        const chunks: string[] = [];
        for (let index = 0; index < codecs.length; index++) {
          chunks.push(yield* codecs[index]!.encode(values[index]));
        }
        // Absent syntax prints nothing and must not leave extra separators.
        return chunks.filter((chunk) => chunk.length > 0).join(separator);
      }) as Effect.Effect<string, EncodeError | Errors<C[number]>, Requirements<C[number]>>,
  });
};

export const struct = <const C extends Readonly<Record<string, AnyCodec>>>(
  fields: C,
  separator = "",
): Codec<
  { readonly [K in keyof C]: Value<C[K]> },
  Errors<C[keyof C]>,
  Requirements<C[keyof C]>
> => {
  type Values = { readonly [K in keyof C]: Value<C[K]> };
  const keys = Object.keys(fields) as (keyof C & string)[];
  return transform(
    tuple(
      keys.map((key) => fields[key]!),
      separator,
    ),
    {
      decode: (values) => Object.fromEntries(keys.map((key, i) => [key, values[i]])) as Values,
      encode: (value: Values) => keys.map((key) => value[key]),
    },
  );
};

/** Explicit commitment; unrelated service errors and defects pass through unchanged. */
export const commit = <A, E, R>(codec: Codec<A, E, R>): Codec<A, E, R> =>
  make({
    decode: (cursor) =>
      Effect.mapError(codec.decode(cursor), (error) =>
        error instanceof ParseError ? commitError(error) : error,
      ),
    encode: codec.encode,
  });

/** Same semantic domain in every branch. Encoding always uses the canonical first branch. */
export const alternatives = <A, E, R>(
  first: Codec<A, E, R>,
  ...rest: readonly Codec<A, E, R>[]
): Codec<A, E, R> =>
  make({
    decode: (cursor) =>
      Effect.gen(function* () {
        let best: ParseError | undefined;
        for (const codec of [first, ...rest]) {
          const result = yield* Effect.result(codec.decode(cursor));
          if (Result.isSuccess(result)) return result.success;
          const error = result.failure;
          if (!(error instanceof ParseError) || error.committed) return yield* Effect.fail(error);
          best = best ? mergeErrors(best, error) : error;
        }
        return yield* Effect.fail(best!);
      }),
    encode: first.encode,
  });

/** Each member's _tag must match its map key; encoding dispatches without trial and error. */
export const taggedUnion = <const C extends Readonly<Record<string, AnyCodec>>>(
  members: C & {
    readonly [K in keyof C]: Value<C[K]> extends { readonly _tag: K } ? unknown : never;
  },
): Codec<Value<C[keyof C]>, Errors<C[keyof C]>, Requirements<C[keyof C]>> => {
  type A = Value<C[keyof C]>;
  type E = Errors<C[keyof C]>;
  type R = Requirements<C[keyof C]>;
  const codecs = Object.values(members) as Codec<A, E, R>[];
  if (codecs.length === 0) throw new TypeError("taggedUnion requires at least one member");
  return make({
    decode: alternatives(codecs[0]!, ...codecs.slice(1)).decode,
    encode: (value) => {
      const tag: unknown = (value as { readonly _tag?: unknown } | null)?._tag;
      if (typeof tag !== "string" || !Object.hasOwn(members, tag)) {
        return Effect.fail(new EncodeError({ message: `Unknown union tag: ${String(tag)}` }));
      }
      return members[tag]!.encode(value) as Effect.Effect<string, EncodeError | E, R>;
    },
  });
};

export const optional = <A, E, R>(codec: Codec<A, E, R>): Codec<A | undefined, E, R> =>
  make({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(codec.decode(cursor));
        if (Result.isSuccess(result)) return result.success;
        const error = result.failure;
        if (!(error instanceof ParseError) || error.committed) return yield* Effect.fail(error);
        return read(undefined, cursor);
      }),
    encode: (value) => (value === undefined ? Effect.succeed("") : codec.encode(value)),
  });

export const prefixed = <A, E, R, E2, R2>(
  prefix: Codec<void, E2, R2>,
  body: Codec<A, E, R>,
  separator = "",
): Codec<A, E | E2, R | R2> =>
  transform(tuple([prefix, commit(body)], separator), {
    decode: ([, value]) => value,
    encode: (value: A) => [undefined, value] as const,
  });

export const followedBy = <A, E, R, E2, R2>(
  body: Codec<A, E, R>,
  suffix: Codec<void, E2, R2>,
  separator = "",
): Codec<A, E | E2, R | R2> =>
  transform(tuple([body, commit(suffix)], separator), {
    decode: ([value]) => value,
    encode: (value: A) => [value, undefined] as const,
  });

/** A separator commits to another item: a trailing comma is always an error. */
export function repeat<A, E, R>(
  item: Codec<A, E, R>,
  options?: { readonly min?: number; readonly join?: string },
): Codec<readonly A[], E, R>;
export function repeat<A, E, R, E2, R2>(
  item: Codec<A, E, R>,
  options: { readonly min?: number; readonly separator: Codec<void, E2, R2> },
): Codec<readonly A[], E | E2, R | R2>;
export function repeat<A, E, R, E2, R2>(
  item: Codec<A, E, R>,
  options: {
    readonly min?: number;
    readonly separator?: Codec<void, E2, R2>;
    readonly join?: string;
  } = {},
): Codec<readonly A[], E | E2, R | R2> {
  const min = options.min ?? 0;
  if (!Number.isSafeInteger(min) || min < 0)
    throw new TypeError("min must be a nonnegative integer");
  return make<readonly A[], E | E2, R | R2>({
    decode: (start) =>
      Effect.gen(function* () {
        let next = start;
        const values: A[] = [];
        const nodes: SourceNode[] = [];
        while (true) {
          let current = next;
          let separatorNodes: readonly SourceNode[] = [];
          let afterSeparator = false;
          if (values.length > 0 && options.separator) {
            const separator = yield* Effect.result(options.separator.decode(current));
            if (Result.isFailure(separator)) {
              const error = separator.failure;
              if (!(error instanceof ParseError) || error.committed || values.length < min) {
                return yield* Effect.fail(error);
              }
              break;
            }
            current = separator.success.next;
            separatorNodes = separator.success.nodes;
            afterSeparator = true;
          }
          const result = yield* Effect.result(item.decode(current));
          if (Result.isFailure(result)) {
            const error = result.failure;
            if (!(error instanceof ParseError)) return yield* Effect.fail(error);
            if (afterSeparator || error.committed || values.length < min) {
              return yield* Effect.fail(afterSeparator ? commitError(error) : error);
            }
            break;
          }
          if (result.success.next.offset <= current.offset) {
            return yield* Effect.fail(
              parseError(current, "a repeated item that consumes input", true),
            );
          }
          values.push(result.success.value);
          nodes.push(...separatorNodes, ...result.success.nodes);
          next = result.success.next;
        }
        return read(values, next, nodes);
      }),
    encode: (values) =>
      Effect.gen(function* () {
        if (!Array.isArray(values) || values.length < min) {
          return yield* Effect.fail(new EncodeError({ message: `Expected at least ${min} items` }));
        }
        const chunks: string[] = [];
        for (let index = 0; index < values.length; index++) {
          if (index > 0)
            chunks.push(
              options.separator ? yield* options.separator.encode(undefined) : (options.join ?? ""),
            );
          const encoded = yield* item.encode(values[index]!);
          if (encoded.length === 0) {
            return yield* Effect.fail(
              new EncodeError({ message: "A repeated item must encode nonempty syntax" }),
            );
          }
          chunks.push(encoded);
        }
        return chunks.join("");
      }),
  });
}

export const located = <A, E, R>(kind: string, codec: Codec<A, E, R>): Codec<A, E, R> =>
  make({
    decode: (cursor) =>
      Effect.map(codec.decode(cursor), (result) => ({
        ...result,
        nodes: [{ kind, start: cursor.offset, end: result.next.offset, children: result.nodes }],
      })),
    encode: codec.encode,
  });
