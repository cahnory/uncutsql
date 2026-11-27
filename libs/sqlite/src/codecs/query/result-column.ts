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
import { skipSqliteTrivia } from "../../operators/trivia.ts";
import type { Expression } from "../expression/types.ts";
import { qualifierName } from "../identifier.ts";
import { resultAlias, resultAliasAfter } from "./alias.ts";
import type { ResultColumn } from "./types.ts";

export type ResultColumnContext = "result" | "from-subquery" | "cte" | "schema";

const keepsBooleanSource = (expression: Expression, derivesNames: boolean): boolean => {
  let operand = expression;
  while (derivesNames && operand._tag === "CollateExpression") {
    operand = operand.operand;
  }
  return (
    operand._tag === "KeywordLiteral" && (operand.value === "TRUE" || operand.value === "FALSE")
  );
};

const trimLabelEnd = (source: string, end: number): number => {
  while (end > 0 && /[ \t\n\v\f\r]/.test(source[end - 1]!)) {
    end--;
  }
  return end;
};

// A line comment ends at the added newline. An open block comment consumes
// the semicolon too, so that spelling cannot be followed by more SQL.
const canFollowWithSql = (source: string, offset: number): boolean =>
  skipSqliteTrivia(`${source}\n;`, offset) === source.length + 1;

// COLLATE preserves direct column names in derived tables and schema definitions.
// Schema definitions also look through likelihood calls.
const derivesColumnName = (expression: Expression, unwrapLikelihood: boolean): boolean => {
  if (expression._tag === "ColumnReference") {
    return true;
  }
  if (expression._tag === "CollateExpression") {
    return derivesColumnName(expression.operand, unwrapLikelihood);
  }
  if (
    unwrapLikelihood &&
    expression._tag === "FunctionCall" &&
    /^(?:likely|unlikely|likelihood)$/i.test(expression.name) &&
    expression.arguments[0] !== undefined
  ) {
    return derivesColumnName(expression.arguments[0], unwrapLikelihood);
  }
  return false;
};

export const resultColumn = (
  expression: Codec<Expression>,
  context: ResultColumnContext,
): Codec<ResultColumn> => {
  const derivesNames = context !== "result";
  const unwrapLikelihood = context === "schema";
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
            const usesColumnName = derivesNames
              ? derivesColumnName(value.value, unwrapLikelihood)
              : value.value._tag === "ColumnReference";
            let resultName = name.value;
            let implicitBooleanSource: string | undefined;
            if (resultName === undefined && !usesColumnName) {
              // SQLite takes the span up to the next token and trims ASCII whitespace.
              const end = skipSqliteTrivia(cursor.source, value.next.offset);
              const source = cursor.source.slice(cursor.offset, trimLabelEnd(cursor.source, end));
              // SQLite chooses the name for a bare boolean or for a collated boolean in
              // a derived table or schema definition. The name can depend on resolution
              // and the original spelling. An open block comment reaches EOF, where
              // this SELECT core cannot have a FROM clause and the keyword is a literal.
              if (
                keepsBooleanSource(value.value, derivesNames) &&
                canFollowWithSql(source, value.next.offset - cursor.offset)
              ) {
                if (value.value._tag !== "KeywordLiteral" || source !== value.value.value) {
                  implicitBooleanSource = source;
                }
              } else {
                resultName = source;
              }
            }
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
              !keepsBooleanSource(value.expression, derivesNames) ||
              Result.isFailure(parsed) ||
              trimLabelEnd(source, source.length) !== source.length ||
              !canFollowWithSql(source, parsed.success.next.offset) ||
              (yield* expression.encode(parsed.success.value)) !== sql
            ) {
              return yield* Effect.fail(
                new EncodeError({ message: "Invalid boolean result spelling" }),
              );
            }
            // Keep a following comma, clause or semicolon outside a line comment.
            return skipSqliteTrivia(`${source};`, parsed.success.next.offset) === source.length
              ? source
              : `${source}\n`;
          }),
      }),
    ),
  });
};
