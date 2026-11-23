import { type Codec, optional, struct, transform } from "@uncutsql/codec";
import { inTableTarget } from "../expression/in-table-target.ts";
import type { Expression } from "../expression/types.ts";
import type { TableSource } from "./types.ts";
import { alias } from "./alias.ts";

export const tableSource = (expression: Codec<Expression>): Codec<TableSource> =>
  transform(struct({ target: inTableTarget(expression), alias: optional(alias) }, " "), {
    decode: ({ target, alias }): TableSource => ({
      ...target,
      ...(alias === undefined ? {} : { alias }),
    }),
    encode: (value: TableSource) => ({ target: value, alias: value.alias }),
  });
