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

/** Reverse reviewed intent, retaining rename pairs and guarding newly added data. */
export const planDownMigration = (up: DatabaseMigration): DatabaseMigration | string => {
  const procedures: MigrationProcedure[] = [];
  const dropGuards: DropGuard[] = [];
  for (const step of up.procedures) {
    switch (step._tag) {
      case "DropTable":
        return `The up migration removed table ${step.table.name}.`;
      case "CreateTable":
        dropGuards.push({ table: step.table.identity });
        procedures.push({ ...step, _tag: "DropTable" });
        break;
      case "CreateTrigger":
      case "DropTrigger":
        procedures.push({
          ...step,
          _tag: step._tag === "CreateTrigger" ? "DropTrigger" : "CreateTrigger",
        });
        break;
      case "CreateView":
      case "DropView":
        procedures.push({ ...step, _tag: step._tag === "CreateView" ? "DropView" : "CreateView" });
        break;
      case "ReplaceView":
      case "ReplaceTrigger":
        procedures.push(swap(step));
        break;
      case "AlterTable":
      case "RenameTable": {
        const changes: TableAlteration[] = [];
        for (const change of step.changes) {
          switch (change._tag) {
            case "ColumnRemoved":
              return `The up migration removed column ${step.before.name}.${change.column.name}.`;
            case "ColumnAdded":
              dropGuards.push({ column: change.column.name, table: step.after.identity });
              changes.push({ ...change, _tag: "ColumnRemoved" });
              break;
            case "IndexAdded":
            case "IndexRemoved":
              changes.push({
                ...change,
                _tag: change._tag === "IndexAdded" ? "IndexRemoved" : "IndexAdded",
              });
              break;
            default:
              if ("fields" in change && change.fields.includes("dataType")) {
                return `The up migration changed the type of ${step.before.name}.${change.before.name}.`;
              }
              changes.push(swap(change));
          }
        }
        procedures.push({ ...swap(step), changes });
      }
    }
  }
  return { procedures, ...(dropGuards.length ? { dropGuards } : {}) };
};

function swap<T extends { readonly after: unknown; readonly before: unknown }>(value: T): T {
  return { ...value, after: value.before, before: value.after };
}
