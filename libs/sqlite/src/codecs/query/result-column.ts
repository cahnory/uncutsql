import { Effect } from "effect";
import {
  type Codec,
  followedBy,
  make,
  optional,
  parseError,
  struct,
  taggedUnion,
  transform,
  prefixed,
} from "@uncutsql/codec";
import { punctuation } from "../../operators/punctuation.ts";
import { identifier } from "../identifier.ts";
import type { Expression } from "../expression/types.ts";
import type { ResultColumn } from "./types.ts";
import { alias } from "./alias.ts";

export const resultColumn = (expression: Codec<Expression>): Codec<ResultColumn> => {
  const qualifiedStar = followedBy(identifier, prefixed(punctuation("."), punctuation("*")));
  // A failed qualified wildcard must leave ordinary column references available.
  const tableStar = make<string>({
    decode: (cursor) =>
      Effect.catch(qualifiedStar.decode(cursor), () => Effect.fail(parseError(cursor, "table.*"))),
    encode: qualifiedStar.encode,
  });
  return taggedUnion({
    StarColumn: transform(punctuation("*"), {
      decode: () => ({ _tag: "StarColumn" as const }),
      encode: (_value: { _tag: "StarColumn" }) => undefined,
    }),
    TableStarColumn: transform(tableStar, {
      decode: (table) => ({ _tag: "TableStarColumn" as const, table }),
      encode: (value) => value.table,
    }),
    ExpressionColumn: transform(struct({ expression, alias: optional(alias) }, " "), {
      decode: ({ expression, alias }) => ({
        _tag: "ExpressionColumn" as const,
        expression,
        ...(alias === undefined ? {} : { alias }),
      }),
      encode: (value) => ({ expression: value.expression, alias: value.alias }),
    }),
  });
};
