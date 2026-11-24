import { Data, Effect } from "effect";

import { schemaValueEqual, tableKey } from "./model.ts";
import type {
  Constraint,
  DatabaseColumn,
  DatabaseIndex,
  DatabaseSchema,
  DatabaseTable,
  DatabaseTrigger,
  DatabaseView,
  SchemaValue,
  TableIdentity,
} from "./model.ts";

export interface DiffDiagnostic {
  /** Dialect adapters may contribute their own validation codes. */
  readonly code: string;
  readonly column?: string;
  readonly message: string;
  readonly side: "before" | "after";
  readonly table: TableIdentity;
}
export class SchemaDiffError extends Data.TaggedError("SchemaDiffError")<{
  readonly diagnostics: readonly DiffDiagnostic[];
}> {
  override get message(): string {
    return this.diagnostics.map((item) => `${item.side}: ${item.message}`).join("\n");
  }
}
export type TableAlteration =
  | { readonly _tag: "IndexAdded"; readonly index: DatabaseIndex }
  | { readonly _tag: "IndexRemoved"; readonly index: DatabaseIndex }
  | { readonly _tag: "IndexChanged"; readonly after: DatabaseIndex; readonly before: DatabaseIndex }
  | {
      readonly _tag: "ColumnRenamed";
      readonly after: DatabaseColumn;
      readonly before: DatabaseColumn;
      readonly fields: readonly ("dataType" | "constraints")[];
    }
  | { readonly _tag: "ColumnAdded"; readonly column: DatabaseColumn; readonly position: number }
  | { readonly _tag: "ColumnRemoved"; readonly column: DatabaseColumn; readonly position: number }
  | {
      readonly _tag: "ColumnChanged";
      readonly after: DatabaseColumn;
      readonly before: DatabaseColumn;
      readonly fields: readonly ("dataType" | "constraints")[];
    }
  | {
      readonly _tag: "ColumnOrderChanged";
      readonly after: readonly string[];
      readonly before: readonly string[];
    }
  | {
      readonly _tag: "TableConstraintsChanged";
      readonly after: readonly Constraint[];
      readonly before: readonly Constraint[];
    }
  | {
      readonly _tag: "TableOptionsChanged";
      readonly after: { readonly [key: string]: SchemaValue };
      readonly before: { readonly [key: string]: SchemaValue };
    };
interface TableChanges {
  readonly after: DatabaseTable;
  readonly before: DatabaseTable;
  readonly changes: readonly TableAlteration[];
  readonly table: TableIdentity;
}
export type TableChange =
  | {
      readonly _tag: "TableAdded";
      readonly definition: DatabaseTable;
      readonly table: TableIdentity;
    }
  | {
      readonly _tag: "TableRemoved";
      readonly definition: DatabaseTable;
      readonly table: TableIdentity;
    }
  | (TableChanges & { readonly _tag: "TableChanged" })
  | (TableChanges & { readonly _tag: "TableRenamed" });
export type ViewChange =
  | { readonly _tag: "ViewAdded" | "ViewRemoved"; readonly view: DatabaseView }
  | { readonly _tag: "ViewChanged"; readonly after: DatabaseView; readonly before: DatabaseView };

export type TriggerChange =
  | { readonly _tag: "TriggerAdded" | "TriggerRemoved"; readonly trigger: DatabaseTrigger }
  | {
      readonly _tag: "TriggerChanged";
      readonly after: DatabaseTrigger;
      readonly before: DatabaseTrigger;
    };

export interface DropGuard {
  /** Source column name. Omit to require an empty table. */
  readonly column?: string;
  readonly table: TableIdentity;
}
export interface DatabaseDiff {
  readonly changes: readonly (TableChange | ViewChange | TriggerChange)[];
  readonly dropGuards?: readonly DropGuard[];
}

export const validateDatabase = (
  database: DatabaseSchema,
  side: DiffDiagnostic["side"],
): readonly DiffDiagnostic[] => {
  const diagnostics: DiffDiagnostic[] = [];
  const tables = new Set<string>();
  const indexes = new Set<string>();
  for (const table of database.tables) {
    const id = tableKey(table.identity);
    if (tables.has(id)) {
      diagnostics.push({
        code: "DuplicateTable",
        message: `Duplicate table ${id}`,
        side,
        table: table.identity,
      });
    }
    tables.add(id);
    const columns = new Set<string>();
    for (const column of table.columns) {
      if (columns.has(column.key)) {
        diagnostics.push({
          code: "DuplicateColumn",
          column: column.key,
          message: `Duplicate column ${JSON.stringify(column.key)} in table ${id}`,
          side,
          table: table.identity,
        });
      }
      columns.add(column.key);
    }
  }
  for (const table of database.tables) {
    for (const index of table.indexes ?? []) {
      const id = JSON.stringify([tableKey(table.identity), index.key]);
      if (indexes.has(id)) {
        diagnostics.push({
          code: "DuplicateIndex",
          message: `Duplicate or conflicting index identity ${id}`,
          side,
          table: table.identity,
        });
      }
      indexes.add(id);
      if (!index.terms.length) {
        diagnostics.push({
          code: "EmptyIndex",
          message: `Index ${id} requires at least one term`,
          side,
          table: table.identity,
        });
      }
    }
  }
  const views = new Set<string>();
  for (const view of database.views ?? []) {
    const id = tableKey(view.identity);
    if (views.has(id)) {
      diagnostics.push({
        code: "DuplicateView",
        message: `Duplicate view ${id}`,
        side,
        table: view.identity,
      });
    }
    views.add(id);
  }
  const triggers = new Set<string>();
  for (const trigger of database.triggers ?? []) {
    const id = tableKey(trigger.identity);
    if (triggers.has(id)) {
      diagnostics.push({
        code: "DuplicateTrigger",
        message: `Duplicate trigger ${id}`,
        side,
        table: trigger.identity,
      });
    }
    triggers.add(id);
  }
  return diagnostics;
};
const constraintsEqual = (before: readonly Constraint[], after: readonly Constraint[]): boolean =>
  before.length === after.length &&
  before.every(
    (item, index) =>
      item.kind === after[index]!.kind &&
      schemaValueEqual(item.properties, after[index]!.properties),
  );

export const compareTable = (
  before: DatabaseTable,
  after: DatabaseTable,
): readonly TableAlteration[] => {
  const changes: TableAlteration[] = [];
  const previous = new Map(before.columns.map((column) => [column.key, column]));
  const next = new Map(after.columns.map((column) => [column.key, column]));
  for (const [position, column] of before.columns.entries()) {
    if (!next.has(column.key)) {
      changes.push({ _tag: "ColumnRemoved", column, position });
    }
  }
  for (const [position, column] of after.columns.entries()) {
    const old = previous.get(column.key);
    if (!old) {
      changes.push({ _tag: "ColumnAdded", column, position });
      continue;
    }
    const fields: ("dataType" | "constraints")[] = [];
    if (!schemaValueEqual(old.dataType, column.dataType)) {
      fields.push("dataType");
    }
    if (!constraintsEqual(old.constraints, column.constraints)) {
      fields.push("constraints");
    }
    if (fields.length) {
      changes.push({ _tag: "ColumnChanged", after: column, before: old, fields });
    }
  }
  const oldOrder = before.columns
    .filter((column) => next.has(column.key))
    .map((column) => column.key);
  const newOrder = after.columns
    .filter((column) => previous.has(column.key))
    .map((column) => column.key);
  if (!schemaValueEqual(oldOrder, newOrder)) {
    changes.push({ _tag: "ColumnOrderChanged", after: newOrder, before: oldOrder });
  }
  if (!constraintsEqual(before.constraints, after.constraints)) {
    changes.push({
      _tag: "TableConstraintsChanged",
      after: after.constraints,
      before: before.constraints,
    });
  }
  if (!schemaValueEqual(before.options, after.options)) {
    changes.push({ _tag: "TableOptionsChanged", after: after.options, before: before.options });
  }
  const oldIndexes = new Map((before.indexes ?? []).map((index) => [index.key, index]));
  const newIndexes = new Map((after.indexes ?? []).map((index) => [index.key, index]));
  for (const [key, index] of oldIndexes) {
    if (!newIndexes.has(key)) {
      changes.push({ _tag: "IndexRemoved", index });
    }
  }
  for (const [key, index] of newIndexes) {
    const old = oldIndexes.get(key);
    if (!old) {
      changes.push({ _tag: "IndexAdded", index });
    } else if (
      old.unique !== index.unique ||
      !schemaValueEqual(old.terms, index.terms) ||
      !schemaValueEqual(old.where, index.where)
    ) {
      changes.push({ _tag: "IndexChanged", after: index, before: old });
    }
  }
  return changes;
};

/** Compare normalized relational models without parsing SQL or consulting a dialect. */
export const diffDatabases = (
  before: DatabaseSchema,
  after: DatabaseSchema,
): Effect.Effect<DatabaseDiff, SchemaDiffError> =>
  Effect.gen(function* () {
    const diagnostics = [
      ...validateDatabase(before, "before"),
      ...validateDatabase(after, "after"),
    ];
    if (diagnostics.length) {
      return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    }
    const previous = new Map(before.tables.map((table) => [tableKey(table.identity), table]));
    const next = new Map(after.tables.map((table) => [tableKey(table.identity), table]));
    const changes: (TableChange | ViewChange | TriggerChange)[] = [];
    for (const [key, table] of previous) {
      if (!next.has(key)) {
        changes.push({ _tag: "TableRemoved", definition: table, table: table.identity });
      }
    }
    for (const [key, table] of next) {
      const old = previous.get(key);
      if (!old) {
        changes.push({ _tag: "TableAdded", definition: table, table: table.identity });
      } else {
        const alterations = compareTable(old, table);
        if (alterations.length) {
          changes.push({
            _tag: "TableChanged",
            after: table,
            before: old,
            changes: alterations,
            table: table.identity,
          });
        }
      }
    }
    const oldViews = new Map((before.views ?? []).map((view) => [tableKey(view.identity), view]));
    const newViews = new Map((after.views ?? []).map((view) => [tableKey(view.identity), view]));
    for (const [key, view] of oldViews) {
      if (!newViews.has(key)) {
        changes.push({ _tag: "ViewRemoved", view });
      }
    }
    for (const [key, view] of newViews) {
      const old = oldViews.get(key);
      if (!old) {
        changes.push({ _tag: "ViewAdded", view });
      } else if (
        !schemaValueEqual(old.columns ?? null, view.columns ?? null) ||
        !schemaValueEqual(old.query, view.query)
      ) {
        changes.push({ _tag: "ViewChanged", after: view, before: old });
      }
    }
    const oldTriggers = new Map(
      (before.triggers ?? []).map((trigger) => [tableKey(trigger.identity), trigger]),
    );
    const newTriggers = new Map(
      (after.triggers ?? []).map((trigger) => [tableKey(trigger.identity), trigger]),
    );
    for (const [key, trigger] of oldTriggers) {
      if (!newTriggers.has(key)) {
        changes.push({ _tag: "TriggerRemoved", trigger });
      }
    }
    for (const [key, trigger] of newTriggers) {
      const old = oldTriggers.get(key);
      if (!old) {
        changes.push({ _tag: "TriggerAdded", trigger });
      } else if (
        tableKey(old.target) !== tableKey(trigger.target) ||
        !schemaValueEqual(old.definition, trigger.definition)
      ) {
        changes.push({ _tag: "TriggerChanged", after: trigger, before: old });
      }
    }
    return { changes };
  });
