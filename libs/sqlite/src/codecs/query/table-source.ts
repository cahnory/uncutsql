import { type Codec, make, optional, struct, taggedUnion, transform } from "@uncutsql/codec";
import { parenthesized } from "../../operators/parenthesized.ts";
import { inTableTarget } from "../expression/in-table-target.ts";
import type { Expression } from "../expression/types.ts";
import type { Query, TableSource } from "./types.ts";
import { query } from "./query.ts";
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
  return transform(struct({ target, alias: optional(alias) }, " "), {
    decode: ({ target, alias }): TableSource => ({
      ...(target._tag === "Table" ? target.target : target),
      ...(alias === undefined ? {} : { alias }),
    }),
    encode: (value: TableSource) => ({
      target: "_tag" in value ? value : { _tag: "Table" as const, target: value },
      alias: value.alias,
    }),
  });
};
