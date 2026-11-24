import { Effect, Result } from "effect";
import { type Codec, commit, make, optional, prefixed, read } from "@uncutsql/codec";
import { nameIdentifier } from "../codecs/identifier.ts";
import { keyword } from "./keyword.ts";
import { skipSqliteTrivia } from "./trivia.ts";

const label = prefixed(keyword("CONSTRAINT"), nameIdentifier, " ");

export type Named<A> = A & { readonly name?: string };

export const namedConstraint = <A extends { readonly _tag: string }>(
  body: Codec<A>,
): Codec<Named<A>> => {
  const name = optional(label);
  return make<Named<A>>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const prefix = yield* name.decode(cursor);
        const result = yield* (prefix.value === undefined ? body : commit(body)).decode(
          prefix.next,
        );
        const value =
          prefix.value === undefined ? result.value : { ...result.value, name: prefix.value };
        return read(value, result.next, [...prefix.nodes, ...result.nodes]);
      }),
    encode: (value) =>
      Effect.gen(function* () {
        const sql = yield* body.encode(value);
        if (value.name === undefined) return sql;
        return `CONSTRAINT ${yield* nameIdentifier.encode(value.name)} ${sql}`;
      }),
  });
};

/** A label at the end of a definition item contributes no constraint to the schema. */
export const constraintEntry = <A>(constraint: Codec<A>): Codec<A | undefined> =>
  make<A | undefined>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.result(constraint.decode(cursor));
        if (Result.isSuccess(parsed)) return parsed.success;
        if (parsed.failure.committed) {
          const prefix = yield* Effect.result(label.decode(cursor));
          if (Result.isSuccess(prefix)) {
            const { next, nodes } = prefix.success;
            const delimiter = next.source[skipSqliteTrivia(next.source, next.offset)];
            if (delimiter === "," || delimiter === ")") return read(undefined, next, nodes);
          }
        }
        return yield* Effect.fail(parsed.failure);
      }),
    encode: (value) => (value === undefined ? Effect.succeed("") : constraint.encode(value)),
  });
