import { Data, Effect } from "effect";
import {
  type Constraint,
  type DatabaseSchema,
  type DatabaseTable,
  type DatabaseColumn,
  type TableIdentity,
  type SchemaValue,
  tableKey,
  schemaValueEqual,
} from "./model.ts";

export interface DiffDiagnostic {
  /** Dialect adapters may contribute their own validation codes. */
  readonly code: string;
  readonly side: "before" | "after";
  readonly table: TableIdentity;
  readonly column?: string;
  readonly message: string;
}
export class SchemaDiffError extends Data.TaggedError("SchemaDiffError")<{
  readonly diagnostics: readonly DiffDiagnostic[];
}> {
  override get message(): string {
    return this.diagnostics.map((item) => `${item.side}: ${item.message}`).join("\n");
  }
}
export type TableAlteration =
  | { readonly _tag: "ColumnAdded"; readonly column: DatabaseColumn; readonly position: number }
  | { readonly _tag: "ColumnRemoved"; readonly column: DatabaseColumn; readonly position: number }
  | {
      readonly _tag: "ColumnChanged";
      readonly before: DatabaseColumn;
      readonly after: DatabaseColumn;
      readonly fields: readonly ("dataType" | "constraints")[];
    }
  | {
      readonly _tag: "ColumnOrderChanged";
      readonly before: readonly string[];
      readonly after: readonly string[];
    }
  | {
      readonly _tag: "TableConstraintsChanged";
      readonly before: readonly Constraint[];
      readonly after: readonly Constraint[];
    }
  | {
      readonly _tag: "TableOptionsChanged";
      readonly before: { readonly [key: string]: SchemaValue };
      readonly after: { readonly [key: string]: SchemaValue };
    };
export type TableChange =
  | {
      readonly _tag: "TableAdded";
      readonly table: TableIdentity;
      readonly definition: DatabaseTable;
    }
  | {
      readonly _tag: "TableRemoved";
      readonly table: TableIdentity;
      readonly definition: DatabaseTable;
    }
  | {
      readonly _tag: "TableChanged";
      readonly table: TableIdentity;
      readonly before: DatabaseTable;
      readonly after: DatabaseTable;
      readonly changes: readonly TableAlteration[];
    };
export interface DatabaseDiff {
  readonly changes: readonly TableChange[];
}

export const validateDatabase = (
  database: DatabaseSchema,
  side: DiffDiagnostic["side"],
): readonly DiffDiagnostic[] => {
  const diagnostics: DiffDiagnostic[] = [];
  const tables = new Set<string>();
  for (const table of database.tables) {
    const id = tableKey(table.identity);
    if (tables.has(id))
      diagnostics.push({
        code: "DuplicateTable",
        side,
        table: table.identity,
        message: `Duplicate table ${id}`,
      });
    tables.add(id);
    const columns = new Set<string>();
    for (const column of table.columns) {
      if (columns.has(column.key))
        diagnostics.push({
          code: "DuplicateColumn",
          side,
          table: table.identity,
          column: column.key,
          message: `Duplicate column ${JSON.stringify(column.key)} in table ${id}`,
        });
      columns.add(column.key);
    }
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

const compareTable = (before: DatabaseTable, after: DatabaseTable): readonly TableAlteration[] => {
  const changes: TableAlteration[] = [];
  const previous = new Map(before.columns.map((column) => [column.key, column]));
  const next = new Map(after.columns.map((column) => [column.key, column]));
  for (const [position, column] of before.columns.entries()) {
    if (!next.has(column.key)) changes.push({ _tag: "ColumnRemoved", column, position });
  }
  for (const [position, column] of after.columns.entries()) {
    const old = previous.get(column.key);
    if (!old) {
      changes.push({ _tag: "ColumnAdded", column, position });
      continue;
    }
    const fields: ("dataType" | "constraints")[] = [];
    if (!schemaValueEqual(old.dataType, column.dataType)) fields.push("dataType");
    if (!constraintsEqual(old.constraints, column.constraints)) fields.push("constraints");
    if (fields.length) changes.push({ _tag: "ColumnChanged", before: old, after: column, fields });
  }
  const oldOrder = before.columns
    .filter((column) => next.has(column.key))
    .map((column) => column.key);
  const newOrder = after.columns
    .filter((column) => previous.has(column.key))
    .map((column) => column.key);
  if (!schemaValueEqual(oldOrder, newOrder))
    changes.push({ _tag: "ColumnOrderChanged", before: oldOrder, after: newOrder });
  if (!constraintsEqual(before.constraints, after.constraints))
    changes.push({
      _tag: "TableConstraintsChanged",
      before: before.constraints,
      after: after.constraints,
    });
  if (!schemaValueEqual(before.options, after.options))
    changes.push({ _tag: "TableOptionsChanged", before: before.options, after: after.options });
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
    if (diagnostics.length) return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    const previous = new Map(before.tables.map((table) => [tableKey(table.identity), table]));
    const next = new Map(after.tables.map((table) => [tableKey(table.identity), table]));
    const changes: TableChange[] = [];
    for (const [key, table] of previous)
      if (!next.has(key))
        changes.push({ _tag: "TableRemoved", table: table.identity, definition: table });
    for (const [key, table] of next) {
      const old = previous.get(key);
      if (!old) changes.push({ _tag: "TableAdded", table: table.identity, definition: table });
      else {
        const alterations = compareTable(old, table);
        if (alterations.length)
          changes.push({
            _tag: "TableChanged",
            table: table.identity,
            before: old,
            after: table,
            changes: alterations,
          });
      }
    }
    return { changes };
  });
