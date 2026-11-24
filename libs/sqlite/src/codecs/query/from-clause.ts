import { Effect } from "effect";

import {
  EncodeError,
  make,
  optional,
  parseError,
  repeat,
  struct,
  transform,
} from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import type { Expression } from "../expression/types.ts";
import { joinConstraint } from "./join-constraint.ts";
import { joinOperator } from "./join-operator.ts";
import { tableSource } from "./table-source.ts";
import type { FromClause, JoinedSource } from "./types.ts";

const isJoined = (value: FromClause): value is JoinedSource => "_tag" in value;
export const fromClause = (expression: Codec<Expression>): Codec<FromClause> => {
  const source = tableSource(expression);
  const syntax = transform(
    struct(
      {
        head: source,
        joins: repeat(
          struct(
            {
              operator: joinOperator,
              right: source,
              constraint: optional(joinConstraint(expression)),
            },
            " ",
          ),
          { join: " " },
        ),
      },
      " ",
    ),
    {
      decode: ({ head, joins }): FromClause =>
        joins.every((join) => join.operator._tag === "CommaJoin" && join.constraint === undefined)
          ? [head, ...joins.map((join) => join.right)]
          : {
              _tag: "JoinedSource",
              head,
              joins: joins.map(({ constraint, operator, right }) => ({
                operator,
                right,
                ...(constraint === undefined ? {} : { constraint }),
              })),
            },
      encode: (value: FromClause) =>
        isJoined(value)
          ? {
              head: value.head,
              joins: value.joins.map((join) => ({ ...join, constraint: join.constraint })),
            }
          : {
              head: value[0]!,
              joins: value.slice(1).map((right) => ({
                constraint: undefined,
                operator: { _tag: "CommaJoin" as const },
                right,
              })),
            },
    },
  );
  const valid = (value: FromClause) =>
    isJoined(value)
      ? value.joins.length > 0 &&
        value.joins.every(
          (join) =>
            !(
              join.operator._tag === "KeywordJoin" &&
              join.operator.modifiers.includes("NATURAL") &&
              join.constraint !== undefined
            ),
        )
      : value.length > 0;
  return make<FromClause>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* syntax.decode(cursor);
        if (!valid(result.value)) {
          return yield* Effect.fail(parseError(cursor, "NATURAL JOIN without ON or USING", true));
        }
        return result;
      }),
    encode: (value) =>
      valid(value)
        ? syntax.encode(value)
        : Effect.fail(
            new EncodeError({
              message: "FROM needs a source; NATURAL JOIN cannot have ON or USING",
            }),
          ),
  });
};
