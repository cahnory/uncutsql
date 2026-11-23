import { Effect } from "effect";
import {
  type Codec,
  type Value,
  read,
  EncodeError,
  make,
  optional,
  parseError,
  prefixed,
  repeat,
  struct,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { orderingTerm } from "../ordering-term.ts";
import type { Expression } from "../expression/types.ts";
import { selectCore } from "./select-query.ts";
import { valuesQuery } from "./values-query.ts";
import { limitClause } from "./limit-clause.ts";
import type { Query } from "./types.ts";

export const query = (expression: Codec<Expression>): Codec<Query> => {
  const core = taggedUnion({
    SelectQuery: selectCore(expression),
    ValuesQuery: valuesQuery(expression),
  });
  const syntax = struct(
    {
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
  const toQuery = ({ head, rest, orderBy, limit }: Value<typeof syntax>): Query =>
    rest.length === 0
      ? {
          ...head,
          ...(orderBy === undefined ? {} : { orderBy }),
          ...(limit === undefined ? {} : { limit }),
        }
      : {
          _tag: "CompoundQuery",
          head,
          rest,
          ...(orderBy === undefined ? {} : { orderBy }),
          ...(limit === undefined ? {} : { limit }),
        };
  const mapped = transform(syntax, {
    decode: toQuery,
    encode: (value: Query) => ({
      head: value._tag === "CompoundQuery" ? value.head : value,
      rest: value._tag === "CompoundQuery" ? value.rest : [],
      orderBy: value._tag === "ValuesQuery" ? undefined : value.orderBy,
      limit: value._tag === "ValuesQuery" ? undefined : value.limit,
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
              ("limit" in core && core.limit !== undefined),
          )
        ) {
          return Effect.fail(
            new EncodeError({
              message: "Compound ORDER BY and LIMIT belong to the complete query",
            }),
          );
        }
        if (value.rest.length === 0)
          return Effect.fail(
            new EncodeError({ message: "A compound query needs at least two cores" }),
          );
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
