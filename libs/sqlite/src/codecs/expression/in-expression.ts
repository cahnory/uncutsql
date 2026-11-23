import { Effect } from "effect";
import {
  type Cursor,
  type Read,
  commit,
  read,
  repeat,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression, ExpressionAt, InExpression, InTableExpression } from "./types.ts";

import { inTableTarget } from "./in-table-target.ts";

export const inPrecedence = 40;
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
    const target = taggedUnion({
      List: transform(values(at), {
        decode: (values) => ({ _tag: "List" as const, values }),
        encode: (value) => value.values,
      }),
      Table: transform(inTableTarget(at(0)), {
        decode: (target) => ({ _tag: "Table" as const, target }),
        encode: (value) => value.target,
      }),
    });
    const list = yield* commit(target).decode(operator.next);
    const value: InExpression | InTableExpression =
      list.value._tag === "List"
        ? {
            _tag: "InExpression",
            operator: operator.value,
            operand: operand.value,
            values: list.value.values,
          }
        : {
            _tag: "InTableExpression",
            operator: operator.value,
            operand: operand.value,
            target: list.value.target,
          };
    return read<Expression>(value, list.next, [
      {
        kind: value._tag,
        start: start.offset,
        end: list.next.offset,
        children: [...operand.nodes, ...operator.nodes, ...list.nodes],
      },
    ]);
  });

export const encodeIn = (value: InExpression | InTableExpression, at: ExpressionAt) =>
  Effect.gen(function* () {
    const operator = yield* inOperator.encode(value.operator);
    const operand = yield* at(inPrecedence).encode(value.operand);
    const list = yield* value._tag === "InExpression"
      ? values(at).encode(value.values)
      : inTableTarget(at(0)).encode(value.target);
    return `${operand} ${operator} ${list}`;
  });
