import type { DatabaseDiff, TableAlteration } from "./diff.ts";
import type { DatabaseTable } from "./model.ts";

/** Logical procedures, not execution order or physical operations such as a rebuild. */
export type MigrationProcedure =
  | { readonly _tag: "CreateTable"; readonly table: DatabaseTable }
  | { readonly _tag: "DropTable"; readonly table: DatabaseTable }
  | {
      readonly _tag: "AlterTable";
      readonly before: DatabaseTable;
      readonly after: DatabaseTable;
      readonly changes: readonly TableAlteration[];
    };
export interface DatabaseMigration {
  readonly procedures: readonly MigrationProcedure[];
}

export const planDatabaseMigration = (diff: DatabaseDiff): DatabaseMigration => ({
  procedures: diff.changes.map((change): MigrationProcedure => {
    switch (change._tag) {
      case "TableAdded":
        return { _tag: "CreateTable", table: change.definition };
      case "TableRemoved":
        return { _tag: "DropTable", table: change.definition };
      case "TableChanged":
        return {
          _tag: "AlterTable",
          before: change.before,
          after: change.after,
          changes: change.changes,
        };
    }
  }),
});
