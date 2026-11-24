import { Effect } from "effect";

import { commit, read } from "@uncutsql/codec";
import type { Cursor, Read } from "@uncutsql/codec";

import { binaryOperator, binaryPrecedence } from "./operators.ts";
import type { BinaryOperator } from "./operators.ts";
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
      left: left.value,
      operator: operator.value,
      right: right.value,
    };
    return read<Expression>(value, right.next, [
      {
        children: [...left.nodes, ...operator.nodes, ...right.nodes],
        end: right.next.offset,
        kind: "BinaryExpression",
        start: start.offset,
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
