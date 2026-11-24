import { Effect, Result } from "effect";

import { commit, make, prefixed, read, repeat } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { nameIdentifier } from "../codecs/identifier.ts";
import { keyword } from "./keyword.ts";
import { skipSqliteTrivia } from "./trivia.ts";

export const constraintLabel = prefixed(keyword("CONSTRAINT"), nameIdentifier, " ");
const labels = repeat(constraintLabel);

export type Named<A> = A & { readonly name?: string };

export const namedConstraint = <A extends { readonly _tag: string }>(
  body: Codec<A>,
): Codec<Named<A>> =>
  make<Named<A>>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const parsed = yield* labels.decode(cursor);
        const name = parsed.value.at(-1);
        const result = yield* (name === undefined ? body : commit(body)).decode(parsed.next);
        const value = name === undefined ? result.value : { ...result.value, name };
        return read(value, result.next, [...parsed.nodes, ...result.nodes]);
      }),
    encode: (value) =>
      Effect.gen(function* () {
        const sql = yield* body.encode(value);
        if (value.name === undefined) {
          return sql;
        }
        return `${yield* constraintLabel.encode(value.name)} ${sql}`;
      }),
  });

/** A label at the end of a definition item contributes no constraint to the schema. */
export const constraintEntry = <A extends Named<{ readonly _tag: string }>>(
  constraint: Codec<A>,
): Codec<A | string> =>
  make<A | string>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.result(constraint.decode(cursor));
        if (Result.isSuccess(parsed)) {
          return parsed.success;
        }
        if (parsed.failure.committed) {
          const prefix = yield* Effect.result(labels.decode(cursor));
          if (Result.isSuccess(prefix) && prefix.success.value.length > 0) {
            const { next, nodes } = prefix.success;
            const delimiter = next.source[skipSqliteTrivia(next.source, next.offset)];
            if (delimiter === "," || delimiter === ")") {
              return read(prefix.success.value.at(-1)!, next, nodes);
            }
          }
        }
        return yield* Effect.fail(parsed.failure);
      }),
    encode: (value) =>
      typeof value === "string" ? constraintLabel.encode(value) : constraint.encode(value),
  });
