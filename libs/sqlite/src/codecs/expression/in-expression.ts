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
import type {
  Expression,
  ExpressionAt,
  InExpression,
  InTableExpression,
  InQueryExpression,
} from "./types.ts";

import { query } from "../query/query.ts";
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
      Parenthesized: transform(
        parenthesized(
          taggedUnion({
            Query: transform(query(at(0)), {
              decode: (query) => ({ _tag: "Query" as const, query }),
              encode: (value) => value.query,
            }),
            List: transform(repeat(at(0), { separator: punctuation(",", ", ") }), {
              decode: (values) => ({ _tag: "List" as const, values }),
              encode: (value) => value.values,
            }),
          }),
        ),
        {
          decode: (target) => ({ _tag: "Parenthesized" as const, target }),
          encode: (value) => value.target,
        },
      ),
      Table: transform(inTableTarget(at(0)), {
        decode: (target) => ({ _tag: "Table" as const, target }),
        encode: (value) => value.target,
      }),
    });
    const list = yield* commit(target).decode(operator.next);
    const common = { operator: operator.value, operand: operand.value };
    const value: InExpression | InTableExpression | InQueryExpression =
      list.value._tag === "Table"
        ? { _tag: "InTableExpression", ...common, target: list.value.target }
        : list.value.target._tag === "Query"
          ? { _tag: "InQueryExpression", ...common, query: list.value.target.query }
          : { _tag: "InExpression", ...common, values: list.value.target.values };
    return read<Expression>(value, list.next, [
      {
        kind: value._tag,
        start: start.offset,
        end: list.next.offset,
        children: [...operand.nodes, ...operator.nodes, ...list.nodes],
      },
    ]);
  });

export const encodeIn = (
  value: InExpression | InTableExpression | InQueryExpression,
  at: ExpressionAt,
) =>
  Effect.gen(function* () {
    const operator = yield* inOperator.encode(value.operator);
    const operand = yield* at(inPrecedence).encode(value.operand);
    const list = yield* value._tag === "InExpression"
      ? values(at).encode(value.values)
      : value._tag === "InQueryExpression"
        ? parenthesized(query(at(0))).encode(value.query)
        : inTableTarget(at(0)).encode(value.target);
    return `${operand} ${operator} ${list}`;
  });
