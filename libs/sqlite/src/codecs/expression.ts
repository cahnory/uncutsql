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
  parseError,
} from "@uncutsql/codec";
import { mergeErrors } from "@uncutsql/codec";
import { trivia } from "../operators/trivia.ts";
import { literalValue } from "./literal-value.ts";
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

const readPrimary = (cursor: Cursor): Effect.Effect<Read<Expression>, ParseError> =>
  Effect.gen(function* () {
    const choices: readonly Pick<Codec<Expression>, "decode">[] = [
      parenthesizedExpression(at(0)),
      unaryExpression(at),
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
  if (value._tag === "BinaryExpression") return binaryPrecedence[value.operator];
  if (value._tag === "UnaryExpression") return unaryPrecedence[value.operator];
  if (value._tag === "NullTestExpression") return nullTestPrecedence;
  return primaryPrecedence;
};

const encodeExpression = (value: Expression): Effect.Effect<string, EncodeError> => {
  switch (value._tag) {
    case "UnaryExpression":
      return unaryExpression(at).encode(value);
    case "BinaryExpression":
      return encodeBinaryExpression(value, at);
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

const maybeOperator = optional(binaryOperator);
const maybeNullTest = optional(nullTestOperator);
const at: ExpressionAt = (minimumPrecedence) =>
  make<Expression>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const start = (yield* trivia.decode(cursor)).next;
        let left = yield* readPrimary(start);
        while (true) {
          const postfix = yield* maybeNullTest.decode(left.next);
          if (postfix.value !== undefined) {
            if (nullTestPrecedence < minimumPrecedence) return left;
            left = readNullTest(start, left, { ...postfix, value: postfix.value });
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
  ColumnReference,
  UnaryExpression,
  BinaryExpression,
  NullTestExpression,
} from "./expression/types.ts";
export type { BinaryOperator, UnaryOperator } from "./expression/operators.ts";
