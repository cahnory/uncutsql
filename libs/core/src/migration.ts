import type { DatabaseDiff, DropGuard, TableAlteration } from "./diff.ts";
import type { DatabaseTable } from "./model.ts";

interface TableProcedure {
  readonly before: DatabaseTable;
  readonly after: DatabaseTable;
  readonly changes: readonly TableAlteration[];
}
/** Logical procedures, not execution order or physical operations such as a rebuild. */
export type MigrationProcedure =
  | { readonly _tag: "CreateTable"; readonly table: DatabaseTable }
  | { readonly _tag: "DropTable"; readonly table: DatabaseTable }
  | (TableProcedure & { readonly _tag: "AlterTable" })
  | (TableProcedure & { readonly _tag: "RenameTable" });
export interface DatabaseMigration {
  readonly dropGuards?: readonly DropGuard[];
  readonly procedures: readonly MigrationProcedure[];
}

/** Low-level logical lowering of caller-approved intent. Resolve migration decisions first in user-facing workflows. */
export const planDatabaseMigration = (diff: DatabaseDiff): DatabaseMigration => ({
  ...(diff.dropGuards ? { dropGuards: diff.dropGuards } : {}),
  procedures: diff.changes.map((change): MigrationProcedure => {
    switch (change._tag) {
      case "TableAdded":
        return { _tag: "CreateTable", table: change.definition };
      case "TableRemoved":
        return { _tag: "DropTable", table: change.definition };
      case "TableChanged":
      case "TableRenamed":
        return {
          _tag: change._tag === "TableRenamed" ? "RenameTable" : "AlterTable",
          before: change.before,
          after: change.after,
          changes: change.changes,
        };
    }
  }),
});
