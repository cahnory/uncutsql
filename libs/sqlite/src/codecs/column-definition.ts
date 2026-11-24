import { type Value, located, optional, repeat, struct, transform } from "@uncutsql/codec";
import { lexeme } from "../operators/lexeme.ts";
import { constraintEntry } from "../operators/named-constraint.ts";
import { columnConstraint, type ColumnConstraint } from "./column-constraint.ts";
import { nameIdentifier } from "./identifier.ts";
import { columnType } from "./type-name.ts";

export const columnDefinition = lexeme(
  located(
    "ColumnDefinition",
    struct(
      {
        name: nameIdentifier,
        typeName: optional(columnType),
        constraints: transform(repeat(constraintEntry(columnConstraint), { join: " " }), {
          decode: (entries) => entries.filter((entry) => entry !== undefined),
          encode: (constraints: readonly ColumnConstraint[]) => constraints,
        }),
      },
      " ",
    ),
  ),
);
export type ColumnDefinition = Value<typeof columnDefinition>;
