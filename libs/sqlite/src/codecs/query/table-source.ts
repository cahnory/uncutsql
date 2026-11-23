import { Effect } from "effect";
import {
  type Codec,
  EncodeError,
  parseError,
  make,
  optional,
  struct,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import { parenthesized } from "../../operators/parenthesized.ts";
import { inTableTarget } from "../expression/in-table-target.ts";
import type { Expression } from "../expression/types.ts";
import type { Query, TableSource, FromClause } from "./types.ts";
import { query } from "./query.ts";
import { indexHint } from "./index-hint.ts";
import { fromClause } from "./from-clause.ts";
import { alias } from "./alias.ts";

export const tableSource = (expression: Codec<Expression>): Codec<TableSource> => {
  // Defer recursive grammar construction until reading/writing a derived table.
  const nestedQuery = make<Query>({
    decode: (cursor) => query(expression, true).decode(cursor),
    encode: (value) => query(expression, true).encode(value),
  });
  const nestedSources = make<FromClause>({
    decode: (cursor) => fromClause(expression).decode(cursor),
    encode: (value) => fromClause(expression).encode(value),
  });
  const target = taggedUnion({
    Table: transform(inTableTarget(expression), {
      decode: (target) => ({ _tag: "Table" as const, target }),
      encode: (value) => value.target,
    }),
    Parenthesized: transform(
      parenthesized(
        taggedUnion({
          SubquerySource: transform(nestedQuery, {
            decode: (query) => ({ _tag: "SubquerySource" as const, query }),
            encode: (value) => value.query,
          }),
          GroupedSource: transform(nestedSources, {
            decode: (from) => ({ _tag: "GroupedSource" as const, from }),
            encode: (value) => value.from,
          }),
        }),
      ),
      {
        decode: (source) => ({ _tag: "Parenthesized" as const, source }),
        encode: (value) => value.source,
      },
    ),
  });
  const syntax = transform(
    struct({ target, alias: optional(alias), indexHint: optional(indexHint) }, " "),
    {
      decode: ({ target, alias, indexHint }): TableSource => ({
        ...(target._tag === "Table" ? target.target : target.source),
        ...(alias === undefined ? {} : { alias }),
        ...(indexHint === undefined ? {} : { indexHint }),
      }),
      encode: (value: TableSource) => ({
        target:
          "_tag" in value
            ? { _tag: "Parenthesized" as const, source: value }
            : { _tag: "Table" as const, target: value },
        alias: value.alias,
        indexHint: "indexHint" in value ? value.indexHint : undefined,
      }),
    },
  );
  const valid = (value: TableSource) =>
    !(
      "indexHint" in value &&
      value.indexHint !== undefined &&
      ("_tag" in value || value.arguments !== undefined)
    );
  return make<TableSource>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* syntax.decode(cursor);
        if (!valid(result.value))
          return yield* Effect.fail(parseError(cursor, "index hints only on named tables", true));
        return result;
      }),
    encode: (value) =>
      valid(value)
        ? syntax.encode(value)
        : Effect.fail(
            new EncodeError({
              message: "Index hints require a named table, not a function or subquery",
            }),
          ),
  });
};
