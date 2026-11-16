import { Effect } from "effect";
import { type Codec, commit, make, optional, prefixed, read } from "../../codec/index.ts";
import { identifier } from "../codecs/identifier.ts";
import { keyword } from "./keyword.ts";

export type Named<A> = A & { readonly name?: string };

export const namedConstraint = <A extends { readonly _tag: string }>(
  body: Codec<A>,
): Codec<Named<A>> => {
  const name = optional(prefixed(keyword("CONSTRAINT"), identifier, " "));
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
        return `CONSTRAINT ${yield* identifier.encode(value.name)} ${sql}`;
      }),
  });
};
