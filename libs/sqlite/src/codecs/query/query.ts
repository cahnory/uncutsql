import { Effect } from "effect";

import {
  EncodeError,
  make,
  optional,
  parseError,
  prefixed,
  read,
  repeat,
  struct,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import type { Codec, Value } from "@uncutsql/codec";

import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression } from "../expression/types.ts";
import { orderingTerm } from "../ordering-term.ts";
import { limitClause } from "./limit-clause.ts";
import type { ResultColumnContext } from "./result-column.ts";
import { selectCore } from "./select-query.ts";
import type { Query } from "./types.ts";
import { valuesQuery } from "./values-query.ts";
import { withClause } from "./with-clause.ts";

export const query = (
  expression: Codec<Expression>,
  context: ResultColumnContext = "result",
): Codec<Query> => {
  const core = taggedUnion({
    SelectQuery: selectCore(expression, context),
    ValuesQuery: valuesQuery(expression),
  });
  const nested = make<Query>({
    decode: (cursor) => query(expression, "cte").decode(cursor),
    encode: (value) => query(expression, "cte").encode(value),
  });
  const syntax = struct(
    {
      with: optional(withClause(nested)),
      head: core,
      rest: repeat(
        struct(
          { operator: keywordChoice(["UNION ALL", "UNION", "INTERSECT", "EXCEPT"]), query: core },
          " ",
        ),
        { join: " " },
      ),
      orderBy: optional(
        prefixed(
          keywordSequence(["ORDER", "BY"]),
          repeat(orderingTerm(expression), { min: 1, separator: punctuation(",", ", ") }),
          " ",
        ),
      ),
      limit: optional(limitClause(expression)),
    },
    " ",
  );
  const toQuery = ({
    head,
    limit,
    orderBy,
    rest,
    with: withDefinition,
  }: Value<typeof syntax>): Query =>
    rest.length === 0
      ? {
          ...head,
          ...(withDefinition === undefined ? {} : { with: withDefinition }),
          ...(orderBy === undefined ? {} : { orderBy }),
          ...(limit === undefined ? {} : { limit }),
        }
      : {
          _tag: "CompoundQuery",
          ...(withDefinition === undefined ? {} : { with: withDefinition }),
          head,
          rest,
          ...(orderBy === undefined ? {} : { orderBy }),
          ...(limit === undefined ? {} : { limit }),
        };
  const mapped = transform(syntax, {
    decode: toQuery,
    encode: (value: Query) => ({
      head: value._tag === "CompoundQuery" ? value.head : value,
      limit: value._tag === "ValuesQuery" ? undefined : value.limit,
      orderBy: value._tag === "ValuesQuery" ? undefined : value.orderBy,
      rest: value._tag === "CompoundQuery" ? value.rest : [],
      with: value.with,
    }),
  });
  return make<Query>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* syntax.decode(cursor);
        const last = result.value.rest.at(-1)?.query ?? result.value.head;
        if (
          last._tag === "ValuesQuery" &&
          (result.value.orderBy !== undefined || result.value.limit !== undefined)
        ) {
          return yield* Effect.fail(
            parseError(cursor, "a SELECT as the final core before ORDER BY or LIMIT", true),
          );
        }
        return read(toQuery(result.value), result.next, result.nodes);
      }),
    encode: (value) => {
      if (value._tag === "CompoundQuery") {
        if (
          [value.head, ...value.rest.map((part) => part.query)].some(
            (core) =>
              ("orderBy" in core && core.orderBy !== undefined) ||
              ("limit" in core && core.limit !== undefined) ||
              ("with" in core && core.with !== undefined),
          )
        ) {
          return Effect.fail(
            new EncodeError({
              message: "Compound WITH, ORDER BY and LIMIT belong to the complete query",
            }),
          );
        }
        if (value.rest.length === 0) {
          return Effect.fail(
            new EncodeError({ message: "A compound query needs at least two cores" }),
          );
        }
        if (
          value.rest.at(-1)!.query._tag === "ValuesQuery" &&
          (value.orderBy !== undefined || value.limit !== undefined)
        ) {
          return Effect.fail(
            new EncodeError({ message: "ORDER BY and LIMIT cannot follow a final VALUES core" }),
          );
        }
      }
      return mapped.encode(value);
    },
  });
};
