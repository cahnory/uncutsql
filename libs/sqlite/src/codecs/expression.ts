import { castExpression } from "./expression/cast-expression.ts";
import {
  collatePrecedence,
  collateOperator,
  readCollate,
  encodeCollate,
} from "./expression/collate-expression.ts";
import { Effect, Result } from "effect";
import {
  type Codec,
  type Cursor,
  type Read,
  EncodeError,
  ParseError,
  document,
  make,
  optional,
  transform,
  parseError,
} from "@uncutsql/codec";
import { mergeErrors } from "@uncutsql/codec";
import { trivia } from "../operators/trivia.ts";
import { literalValue } from "./literal-value.ts";
import { functionCall } from "./expression/function-call.ts";
import { columnReference } from "./expression/column-reference.ts";
import { readBinaryExpression, encodeBinaryExpression } from "./expression/binary-expression.ts";
import { unaryExpression } from "./expression/unary-expression.ts";
import { parenthesizedExpression } from "./expression/parenthesized-expression.ts";
import {
  binaryOperator,
  binaryPrecedence,
  primaryPrecedence,
  unaryPrecedence,
} from "./expression/operators.ts";
import type { Expression, ExpressionAt } from "./expression/types.ts";
import {
  nullTestOperator,
  nullTestPrecedence,
  readNullTest,
} from "./expression/null-test-expression.ts";

import {
  betweenOperator,
  betweenPrecedence,
  readBetween,
  encodeBetween,
} from "./expression/between-expression.ts";

import { inOperator, inPrecedence, readIn, encodeIn } from "./expression/in-expression.ts";

const readPrimary = (cursor: Cursor): Effect.Effect<Read<Expression>, ParseError> =>
  Effect.gen(function* () {
    const choices: readonly Pick<Codec<Expression>, "decode">[] = [
      parenthesizedExpression(at(0)),
      unaryExpression(at),
      castExpression(at(0)),
      functionCall(at(0)),
      columnReference,
      literalValue,
    ];
    let best = parseError(cursor, "expression");
    for (const choice of choices) {
      const result = yield* Effect.result(choice.decode(cursor));
      if (Result.isSuccess(result)) return result.success;
      if (result.failure.committed) return yield* Effect.fail(result.failure);
      best = mergeErrors(best, result.failure);
    }
    return yield* Effect.fail(best);
  });

const precedenceOf = (value: Expression): number => {
  if (value._tag === "CollateExpression") return collatePrecedence;
  if (value._tag === "InExpression") return inPrecedence;
  if (value._tag === "BetweenExpression") return betweenPrecedence;
  if (value._tag === "BinaryExpression") return binaryPrecedence[value.operator];
  if (value._tag === "UnaryExpression") return unaryPrecedence[value.operator];
  if (value._tag === "NullTestExpression") return nullTestPrecedence;
  return primaryPrecedence;
};

const encodeExpression = (value: Expression): Effect.Effect<string, EncodeError> => {
  switch (value._tag) {
    case "CollateExpression":
      return encodeCollate(value, at);
    case "InExpression":
      return encodeIn(value, at);
    case "BetweenExpression":
      return encodeBetween(value, at);
    case "UnaryExpression":
      return unaryExpression(at).encode(value);
    case "BinaryExpression":
      return encodeBinaryExpression(value, at);
    case "CastExpression":
      return castExpression(at(0)).encode(value);
    case "FunctionCall":
      return functionCall(at(0)).encode(value);
    case "ColumnReference":
      return columnReference.encode(value);
    case "NullTestExpression":
      return Effect.gen(function* () {
        const operator = yield* nullTestOperator.encode(value.operator);
        const operand = yield* at(nullTestPrecedence).encode(value.operand);
        return `${operand} ${operator}`;
      });
    default:
      return literalValue.encode(value);
  }
};

const maybeCollate = optional(
  transform(collateOperator, { decode: () => true as const, encode: (_value: true) => undefined }),
);
const maybeOperator = optional(binaryOperator);
const maybeIn = optional(inOperator);
const maybeBetween = optional(betweenOperator);
const maybeNullTest = optional(nullTestOperator);
const at: ExpressionAt = (minimumPrecedence) =>
  make<Expression>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const start = (yield* trivia.decode(cursor)).next;
        let left = yield* readPrimary(start);
        while (true) {
          if (minimumPrecedence <= collatePrecedence) {
            const operator = yield* maybeCollate.decode(left.next);
            if (operator.value !== undefined) {
              left = yield* readCollate(start, left, { ...operator, value: undefined });
              continue;
            }
          }
          const postfix = yield* maybeNullTest.decode(left.next);
          if (postfix.value !== undefined) {
            if (nullTestPrecedence < minimumPrecedence) return left;
            left = readNullTest(start, left, { ...postfix, value: postfix.value });
            continue;
          }
          const between = yield* maybeBetween.decode(left.next);
          if (between.value !== undefined) {
            if (betweenPrecedence < minimumPrecedence) return left;
            left = yield* readBetween(start, left, { ...between, value: between.value }, at);
            continue;
          }
          const membership = yield* maybeIn.decode(left.next);
          if (membership.value !== undefined) {
            if (inPrecedence < minimumPrecedence) return left;
            left = yield* readIn(start, left, { ...membership, value: membership.value }, at);
            continue;
          }
          const operator = yield* maybeOperator.decode(left.next);
          if (operator.value === undefined || binaryPrecedence[operator.value] < minimumPrecedence)
            return left;
          left = yield* readBinaryExpression(
            start,
            left,
            { ...operator, value: operator.value },
            at,
          );
        }
      }),
    encode: (value) =>
      Effect.map(encodeExpression(value), (sql) =>
        precedenceOf(value) < minimumPrecedence ? `(${sql})` : sql,
      ),
  });

export const expression: Codec<Expression> = at(0);
export const sqlExpression = document(expression, trivia);
export type {
  Expression,
  FunctionCall,
  BetweenExpression,
  InExpression,
  ColumnReference,
  UnaryExpression,
  BinaryExpression,
  NullTestExpression,
  CollateExpression,
  CastExpression,
} from "./expression/types.ts";
export type { BinaryOperator, UnaryOperator } from "./expression/operators.ts";
