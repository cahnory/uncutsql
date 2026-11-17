import { type Value, located, optional, repeat, struct } from "@uncutsql/codec";
import { lexeme } from "../operators/lexeme.ts";
import { columnConstraint } from "./column-constraint.ts";
import { identifier } from "./identifier.ts";
import { columnType } from "./type-name.ts";

export const columnDefinition = lexeme(
  located(
    "ColumnDefinition",
    struct(
      {
        name: identifier,
        typeName: optional(columnType),
        constraints: repeat(columnConstraint, { join: " " }),
      },
      " ",
    ),
  ),
);
export type ColumnDefinition = Value<typeof columnDefinition>;
