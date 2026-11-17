import { Effect } from "effect";
import { type Cursor, type Read, commit, read } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { binaryPrecedence } from "./operators.ts";
import type { BetweenExpression, Expression, ExpressionAt } from "./types.ts";

export const betweenPrecedence = 40;
export const betweenOperator = keywordChoice(["NOT BETWEEN", "BETWEEN"]);

export const readBetween = (
  start: Cursor,
  operand: Read<Expression>,
  operator: Read<BetweenExpression["operator"]>,
  at: ExpressionAt,
) =>
  Effect.gen(function* () {
    // The lower bound ends at AND, but can itself contain a BETWEEN expression.
    const lower = yield* commit(at(binaryPrecedence.AND + 1)).decode(operator.next);
    const delimiter = yield* commit(keyword("AND")).decode(lower.next);
    const upper = yield* commit(at(betweenPrecedence + 1)).decode(delimiter.next);
    const value: BetweenExpression = {
      _tag: "BetweenExpression",
      operator: operator.value,
      operand: operand.value,
      lower: lower.value,
      upper: upper.value,
    };
    return read<Expression>(value, upper.next, [
      {
        kind: "BetweenExpression",
        start: start.offset,
        end: upper.next.offset,
        children: [
          ...operand.nodes,
          ...operator.nodes,
          ...lower.nodes,
          ...delimiter.nodes,
          ...upper.nodes,
        ],
      },
    ]);
  });

export const encodeBetween = (value: BetweenExpression, at: ExpressionAt) =>
  Effect.gen(function* () {
    const operator = yield* betweenOperator.encode(value.operator);
    const operand = yield* at(betweenPrecedence).encode(value.operand);
    const lower = yield* at(binaryPrecedence.AND + 1).encode(value.lower);
    const upper = yield* at(betweenPrecedence + 1).encode(value.upper);
    return `${operand} ${operator} ${lower} AND ${upper}`;
  });
