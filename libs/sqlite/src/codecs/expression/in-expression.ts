import { Effect } from "effect";
import { type Cursor, type Read, commit, read, repeat } from "@uncutsql/codec";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression, ExpressionAt, InExpression } from "./types.ts";

export const inPrecedence = 37;
export const inOperator = keywordChoice(["NOT IN", "IN"]);
const values = (at: ExpressionAt) =>
  parenthesized(repeat(at(0), { separator: punctuation(",", ", ") }));

export const readIn = (
  start: Cursor,
  operand: Read<Expression>,
  operator: Read<InExpression["operator"]>,
  at: ExpressionAt,
) =>
  Effect.gen(function* () {
    const list = yield* commit(values(at)).decode(operator.next);
    const value: InExpression = {
      _tag: "InExpression",
      operator: operator.value,
      operand: operand.value,
      values: list.value,
    };
    return read<Expression>(value, list.next, [
      {
        kind: "InExpression",
        start: start.offset,
        end: list.next.offset,
        children: [...operand.nodes, ...operator.nodes, ...list.nodes],
      },
    ]);
  });

export const encodeIn = (value: InExpression, at: ExpressionAt) =>
  Effect.gen(function* () {
    const operator = yield* inOperator.encode(value.operator);
    const operand = yield* at(inPrecedence).encode(value.operand);
    const list = yield* values(at).encode(value.values);
    return `${operand} ${operator} ${list}`;
  });
