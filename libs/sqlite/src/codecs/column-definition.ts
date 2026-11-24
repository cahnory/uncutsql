import { located, optional, repeat, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { lexeme } from "../operators/lexeme.ts";
import { constraintEntry } from "../operators/named-constraint.ts";
import { columnConstraint } from "./column-constraint.ts";
import type { ColumnConstraint } from "./column-constraint.ts";
import { nameIdentifier } from "./identifier.ts";
import { columnType } from "./type-name.ts";

const columnEntries = lexeme(
  located(
    "ColumnDefinition",
    struct(
      {
        name: nameIdentifier,
        typeName: optional(columnType),
        constraints: repeat(constraintEntry(columnConstraint), { join: " " }),
      },
      " ",
    ),
  ),
);
export interface ColumnDefinition {
  readonly constraints: readonly ColumnConstraint[];
  readonly name: string;
  readonly typeName: string | undefined;
}

interface ColumnWithLabel {
  readonly column: ColumnDefinition;
  readonly label: string | undefined;
}

export const columnWithLabel: Codec<ColumnWithLabel> = transform(columnEntries, {
  decode: ({ constraints: entries, ...fields }): ColumnWithLabel => {
    let label: string | undefined;
    const constraints: ColumnConstraint[] = [];
    for (const entry of entries) {
      if (typeof entry === "string") {
        label = entry;
      } else {
        label = entry.name ?? label;
        constraints.push(label === undefined ? entry : { ...entry, name: label });
      }
    }
    return { column: { ...fields, constraints }, label };
  },
  encode: ({ column, label }) =>
    label !== undefined && label !== column.constraints.at(-1)?.name
      ? { ...column, constraints: [...column.constraints, label] }
      : column,
});

export const columnDefinition: Codec<ColumnDefinition> = transform(columnWithLabel, {
  decode: ({ column }) => column,
  encode: (column: ColumnDefinition) => ({ column, label: undefined }),
});
