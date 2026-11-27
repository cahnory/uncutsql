import { Effect, Result } from "effect";

import {
  EncodeError,
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

import { lexeme } from "../../operators/lexeme.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression } from "../expression/types.ts";
import { qualifierName } from "../identifier.ts";
import type { KeywordLiteral } from "../keyword-literal.ts";
import { resultAlias, resultAliasAfter } from "./alias.ts";
import type { ResultColumn } from "./types.ts";

const isBooleanLiteral = (
  expression: Expression,
): expression is KeywordLiteral & { readonly value: "TRUE" | "FALSE" } =>
  expression._tag === "KeywordLiteral" &&
  (expression.value === "TRUE" || expression.value === "FALSE");

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
  const qualifiedStar = followedBy(qualifierName, prefixed(punctuation("."), punctuation("*")));
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
            const source = cursor.source.slice(cursor.offset, value.next.offset);
            // SQLite chooses the declared column name if the keyword resolves to a
            // column, and uses the expression spelling if it remains a literal.
            const implicitBoolean = name.value === undefined && isBooleanLiteral(value.value);
            const implicitBooleanSource =
              implicitBoolean && source !== value.value.value ? source : undefined;
            const resultName =
              name.value ??
              (implicitBoolean ||
              (schemaNames
                ? derivesColumnName(value.value)
                : value.value._tag === "ColumnReference")
                ? undefined
                : source);
            return read(
              {
                _tag: "ExpressionColumn",
                expression: value.value,
                ...(resultName === undefined ? {} : { alias: resultName }),
                ...(implicitBooleanSource === undefined ? {} : { implicitBooleanSource }),
              },
              name.next,
              [...value.nodes, ...name.nodes],
            );
          }),
        encode: (value) =>
          Effect.gen(function* () {
            const sql = yield* expression.encode(value.expression);
            if (value.alias !== undefined) {
              return `${sql} ${yield* resultAlias.encode(value.alias)}`;
            }
            const source = value.implicitBooleanSource;
            if (source === undefined) {
              return sql;
            }
            const parsed = yield* Effect.result(expression.decode({ offset: 0, source }));
            if (
              !isBooleanLiteral(value.expression) ||
              Result.isFailure(parsed) ||
              parsed.success.next.offset !== source.length ||
              !isBooleanLiteral(parsed.success.value) ||
              parsed.success.value.value !== value.expression.value
            ) {
              return yield* Effect.fail(
                new EncodeError({ message: "Invalid boolean result spelling" }),
              );
            }
            return source;
          }),
      }),
    ),
  });
};
