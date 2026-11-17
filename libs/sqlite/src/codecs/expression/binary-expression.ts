import { Effect } from "effect";
import { type Cursor, type Read, commit, read } from "@uncutsql/codec";
import { binaryOperator, binaryPrecedence, type BinaryOperator } from "./operators.ts";
import type { BinaryExpression, Expression, ExpressionAt } from "./types.ts";

/** Left-associative continuation used by the precedence-climbing grammar. */
export const readBinaryExpression = (
  start: Cursor,
  left: Read<Expression>,
  operator: Read<BinaryOperator>,
  at: ExpressionAt,
) =>
  Effect.gen(function* () {
    const right = yield* commit(at(binaryPrecedence[operator.value] + 1)).decode(operator.next);
    const value: BinaryExpression = {
      _tag: "BinaryExpression",
      operator: operator.value,
      left: left.value,
      right: right.value,
    };
    return read<Expression>(value, right.next, [
      {
        kind: "BinaryExpression",
        start: start.offset,
        end: right.next.offset,
        children: [...left.nodes, ...operator.nodes, ...right.nodes],
      },
    ]);
  });

export const encodeBinaryExpression = (value: BinaryExpression, at: ExpressionAt) =>
  Effect.gen(function* () {
    const operator = yield* binaryOperator.encode(value.operator);
    const precedence = binaryPrecedence[value.operator];
    const left = yield* at(precedence).encode(value.left);
    // Always preserve right-nested equal-precedence trees, even for '+' or '*':
    // reassociation may change SQLite types, overflow behavior or floating-point results.
    const right = yield* at(precedence + 1).encode(value.right);
    return `${left} ${operator} ${right}`;
  });
