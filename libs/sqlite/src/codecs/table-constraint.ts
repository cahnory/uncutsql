import { located, taggedUnion } from "@uncutsql/codec";
import type { Value } from "@uncutsql/codec";

import { lexeme } from "../operators/lexeme.ts";
import { namedConstraint } from "../operators/named-constraint.ts";
import { checkTableConstraint } from "./table-constraint/check-table-constraint.ts";
import { foreignKeyTableConstraint } from "./table-constraint/foreign-key-table-constraint.ts";
import { primaryKeyTableConstraint } from "./table-constraint/primary-key-table-constraint.ts";
import { uniqueTableConstraint } from "./table-constraint/unique-table-constraint.ts";

export const tableConstraint = lexeme(
  located(
    "TableConstraint",
    namedConstraint(
      taggedUnion({
        PrimaryKey: primaryKeyTableConstraint,
        Unique: uniqueTableConstraint,
        Check: checkTableConstraint,
        ForeignKey: foreignKeyTableConstraint,
      }),
    ),
  ),
);
export type TableConstraint = Value<typeof tableConstraint>;
