import { Effect } from "effect";

import { commit, optional, prefixed, read } from "@uncutsql/codec";
import type { Cursor, Read } from "@uncutsql/codec";

import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keyword } from "../../operators/keyword.ts";
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
        left: left.value,
        operator: operator.value,
        right: right.value,
        ...(escape.value === undefined ? {} : { escape: escape.value }),
      },
      escape.next,
      [
        {
          children: [...left.nodes, ...operator.nodes, ...right.nodes, ...escape.nodes],
          end: escape.next.offset,
          kind: "PatternExpression",
          start: start.offset,
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
