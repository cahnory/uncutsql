import { Effect } from "effect";
import { type Cursor, type Read, commit, optional, prefixed, read } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import type { Expression, ExpressionAt, PatternExpression } from "./types.ts";

export const patternPrecedence = 40;
const escapePrecedence = 55;
export const patternOperator = keywordChoice([
  "NOT LIKE",
  "LIKE",
  "NOT GLOB",
  "GLOB",
  "NOT REGEXP",
  "REGEXP",
  "NOT MATCH",
  "MATCH",
]);
export const readPattern = (
  start: Cursor,
  left: Read<Expression>,
  operator: Read<PatternExpression["operator"]>,
  at: ExpressionAt,
) =>
  Effect.gen(function* () {
    const right = yield* commit(at(patternPrecedence + 1)).decode(operator.next);
    const escape = yield* optional(prefixed(keyword("ESCAPE"), at(escapePrecedence))).decode(
      right.next,
    );
    return read<Expression>(
      {
        _tag: "PatternExpression",
        operator: operator.value,
        left: left.value,
        right: right.value,
        ...(escape.value === undefined ? {} : { escape: escape.value }),
      },
      escape.next,
      [
        {
          kind: "PatternExpression",
          start: start.offset,
          end: escape.next.offset,
          children: [...left.nodes, ...operator.nodes, ...right.nodes, ...escape.nodes],
        },
      ],
    );
  });
export const encodePattern = (value: PatternExpression, at: ExpressionAt) =>
  Effect.gen(function* () {
    const operator = yield* patternOperator.encode(value.operator);
    const left = yield* at(patternPrecedence).encode(value.left);
    const right = yield* at(patternPrecedence + 1).encode(value.right);
    const escape =
      value.escape === undefined
        ? ""
        : ` ESCAPE ${yield* at(escapePrecedence).encode(value.escape)}`;
    return `${left} ${operator} ${right}${escape}`;
  });
