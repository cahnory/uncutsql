import { type Value, located, taggedUnion } from "../../codec/index.ts";
import { lexeme } from "../operators/lexeme.ts";
import { namedConstraint } from "../operators/named-constraint.ts";
import { referencesColumnConstraint } from "./column-constraint/references-column-constraint.ts";
import { checkColumnConstraint } from "./column-constraint/check-column-constraint.ts";
import { defaultColumnConstraint } from "./column-constraint/default-column-constraint.ts";
import { notNullColumnConstraint } from "./column-constraint/not-null-column-constraint.ts";
import { primaryKeyColumnConstraint } from "./column-constraint/primary-key-column-constraint.ts";
import { uniqueColumnConstraint } from "./column-constraint/unique-column-constraint.ts";

export const columnConstraint = lexeme(
  located(
    "ColumnConstraint",
    namedConstraint(
      taggedUnion({
        PrimaryKey: primaryKeyColumnConstraint,
        NotNull: notNullColumnConstraint,
        Unique: uniqueColumnConstraint,
        Default: defaultColumnConstraint,
        Check: checkColumnConstraint,
        References: referencesColumnConstraint,
      }),
    ),
  ),
);
export type ColumnConstraint = Value<typeof columnConstraint>;
