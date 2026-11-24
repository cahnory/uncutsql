import type { DatabaseDiff, DropGuard, TableAlteration } from "./diff.ts";
import type { DatabaseTable, DatabaseTrigger, DatabaseView } from "./model.ts";

interface TableProcedure {
  readonly after: DatabaseTable;
  readonly before: DatabaseTable;
  readonly changes: readonly TableAlteration[];
}
/** Logical procedures, not execution order or physical operations such as a rebuild. */
export type MigrationProcedure =
  | { readonly _tag: "CreateTrigger" | "DropTrigger"; readonly trigger: DatabaseTrigger }
  | {
      readonly _tag: "ReplaceTrigger";
      readonly after: DatabaseTrigger;
      readonly before: DatabaseTrigger;
    }
  | { readonly _tag: "CreateView" | "DropView"; readonly view: DatabaseView }
  | { readonly _tag: "ReplaceView"; readonly after: DatabaseView; readonly before: DatabaseView }
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
      case "TriggerAdded":
      case "TriggerRemoved":
        return {
          _tag: change._tag === "TriggerAdded" ? "CreateTrigger" : "DropTrigger",
          trigger: change.trigger,
        };
      case "TriggerChanged":
        return { _tag: "ReplaceTrigger", after: change.after, before: change.before };
      case "ViewAdded":
      case "ViewRemoved":
        return { _tag: change._tag === "ViewAdded" ? "CreateView" : "DropView", view: change.view };
      case "ViewChanged":
        return { _tag: "ReplaceView", after: change.after, before: change.before };
      case "TableAdded":
        return { _tag: "CreateTable", table: change.definition };
      case "TableRemoved":
        return { _tag: "DropTable", table: change.definition };
      case "TableChanged":
      case "TableRenamed":
        return {
          _tag: change._tag === "TableRenamed" ? "RenameTable" : "AlterTable",
          after: change.after,
          before: change.before,
          changes: change.changes,
        };
    }
  }),
});
