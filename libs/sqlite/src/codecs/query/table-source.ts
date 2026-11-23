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
import type { Query, TableSource } from "./types.ts";
import { query } from "./query.ts";
import { indexHint } from "./index-hint.ts";
import { alias } from "./alias.ts";

export const tableSource = (expression: Codec<Expression>): Codec<TableSource> => {
  // Defer recursive grammar construction until reading/writing a derived table.
  const nestedQuery = make<Query>({
    decode: (cursor) => query(expression).decode(cursor),
    encode: (value) => query(expression).encode(value),
  });
  const target = taggedUnion({
    Table: transform(inTableTarget(expression), {
      decode: (target) => ({ _tag: "Table" as const, target }),
      encode: (value) => value.target,
    }),
    SubquerySource: transform(parenthesized(nestedQuery), {
      decode: (query) => ({ _tag: "SubquerySource" as const, query }),
      encode: (value) => value.query,
    }),
  });
  const syntax = transform(
    struct({ target, alias: optional(alias), indexHint: optional(indexHint) }, " "),
    {
      decode: ({ target, alias, indexHint }): TableSource => ({
        ...(target._tag === "Table" ? target.target : target),
        ...(alias === undefined ? {} : { alias }),
        ...(indexHint === undefined ? {} : { indexHint }),
      }),
      encode: (value: TableSource) => ({
        target: "_tag" in value ? value : { _tag: "Table" as const, target: value },
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
