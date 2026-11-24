import { Effect } from "effect";

import {
  followedBy,
  make,
  optional,
  parseError,
  prefixed,
  read,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { contextualNameKeywords } from "../../lexer/keywords.ts";
import { lexeme } from "../../operators/lexeme.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression } from "../expression/types.ts";
import { nameWithKeywords } from "../identifier.ts";
import { resultAlias, resultAliasAfter } from "./alias.ts";
import type { ResultColumn } from "./types.ts";

// At the start of a result expression, SQLite parses these as expressions before
// considering whether the token can stand for a table name.
const tableStarKeywords = new Set(contextualNameKeywords);
for (const word of ["CAST", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "RAISE"]) {
  tableStarKeywords.delete(word);
}
const tableStarName = nameWithKeywords(tableStarKeywords);

// SQLite's derived-table column naming ignores COLLATE and likelihood wrappers
// around a direct column. Top-level result labels instead use their source text.
const derivesColumnName = (expression: Expression): boolean => {
  if (expression._tag === "ColumnReference") {
    return true;
  }
  if (expression._tag === "CollateExpression") {
    return derivesColumnName(expression.operand);
  }
  if (
    expression._tag === "FunctionCall" &&
    /^(?:likely|unlikely|likelihood)$/i.test(expression.name) &&
    expression.arguments[0] !== undefined
  ) {
    return derivesColumnName(expression.arguments[0]);
  }
  return false;
};

export const resultColumn = (
  expression: Codec<Expression>,
  schemaNames = false,
): Codec<ResultColumn> => {
  const qualifiedStar = followedBy(tableStarName, prefixed(punctuation("."), punctuation("*")));
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
    ExpressionColumn: lexeme(
      make<Extract<ResultColumn, { _tag: "ExpressionColumn" }>>({
        decode: (cursor) =>
          Effect.gen(function* () {
            const value = yield* expression.decode(cursor);
            const name = yield* optional(resultAliasAfter(value)).decode(value.next);
            const resultName =
              name.value ??
              ((
                schemaNames
                  ? derivesColumnName(value.value)
                  : value.value._tag === "ColumnReference"
              )
                ? undefined
                : cursor.source.slice(cursor.offset, value.next.offset));
            return read(
              {
                _tag: "ExpressionColumn",
                expression: value.value,
                ...(resultName === undefined ? {} : { alias: resultName }),
              },
              name.next,
              [...value.nodes, ...name.nodes],
            );
          }),
        encode: (value) =>
          Effect.gen(function* () {
            const sql = yield* expression.encode(value.expression);
            return value.alias === undefined
              ? sql
              : `${sql} ${yield* resultAlias.encode(value.alias)}`;
          }),
      }),
    ),
  });
};
