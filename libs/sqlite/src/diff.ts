import { Data, Effect } from "effect";
import { type EncodeError } from "@uncutsql/codec";
import { createTable, type CreateTable, type ColumnDefinition } from "./create-table.ts";
import { columnConstraint } from "./codecs/column-constraint.ts";
import { tableConstraint, type TableConstraint } from "./codecs/table-constraint.ts";
import type { TableOption } from "./codecs/table-options.ts";
import type { Statement } from "./schema.ts";

export interface TableIdentity {
  readonly schema: string;
  readonly name: string;
}

export interface DiffDiagnostic {
  readonly code: "DuplicateTable" | "DuplicateColumn" | "InvalidTemporarySchema";
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
  | { readonly _tag: "ColumnAdded"; readonly column: ColumnDefinition; readonly position: number }
  | { readonly _tag: "ColumnRemoved"; readonly column: ColumnDefinition; readonly position: number }
  | {
      readonly _tag: "ColumnChanged";
      readonly before: ColumnDefinition;
      readonly after: ColumnDefinition;
      readonly fields: readonly ("typeName" | "constraints")[];
    }
  | {
      readonly _tag: "ColumnOrderChanged";
      readonly before: readonly string[];
      readonly after: readonly string[];
    }
  | {
      readonly _tag: "TableConstraintsChanged";
      readonly before: readonly TableConstraint[];
      readonly after: readonly TableConstraint[];
    }
  | {
      readonly _tag: "TableOptionsChanged";
      readonly before: readonly TableOption[];
      readonly after: readonly TableOption[];
    };

export type TableChange =
  | { readonly _tag: "TableAdded"; readonly table: TableIdentity; readonly definition: CreateTable }
  | {
      readonly _tag: "TableRemoved";
      readonly table: TableIdentity;
      readonly definition: CreateTable;
    }
  | {
      readonly _tag: "TableChanged";
      readonly table: TableIdentity;
      readonly before: CreateTable;
      readonly after: CreateTable;
      readonly changes: readonly TableAlteration[];
    };

export interface SchemaDiff {
  readonly changes: readonly TableChange[];
}

// SQLite folds ASCII identifiers. Unicode lowercasing would conflate distinct names.
const fold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const identity = (table: CreateTable): TableIdentity => ({
  schema: fold(table.schema ?? (table.temporary ? "temp" : "main")),
  name: fold(table.name),
});
const key = (table: TableIdentity) => JSON.stringify([table.schema, table.name]);
const equal = (before: readonly string[], after: readonly string[]) =>
  before.length === after.length && before.every((value, index) => value === after[index]);

const indexSchema = (
  statements: readonly Statement[],
  side: DiffDiagnostic["side"],
  diagnostics: DiffDiagnostic[],
) => {
  const tables = new Map<string, CreateTable>();
  for (const table of statements) {
    const id = identity(table);
    const label = JSON.stringify([id.schema, id.name]);
    if (table.temporary && id.schema !== "temp")
      diagnostics.push({
        code: "InvalidTemporarySchema",
        side,
        table: id,
        message: `TEMP table ${label} must use the temp schema`,
      });
    if (tables.has(key(id)))
      diagnostics.push({
        code: "DuplicateTable",
        side,
        table: id,
        message: `Duplicate table ${label}`,
      });
    else tables.set(key(id), table);
    const columns = new Set<string>();
    for (const column of table.columns) {
      const name = fold(column.name);
      if (columns.has(name))
        diagnostics.push({
          code: "DuplicateColumn",
          side,
          table: id,
          column: name,
          message: `Duplicate column ${JSON.stringify(name)} in table ${label}`,
        });
      columns.add(name);
    }
  }
  return tables;
};

const compareTable = (before: CreateTable, after: CreateTable) =>
  Effect.gen(function* () {
    const changes: TableAlteration[] = [];
    const previous = new Map(before.columns.map((column) => [fold(column.name), column]));
    const next = new Map(after.columns.map((column) => [fold(column.name), column]));
    for (const [position, column] of before.columns.entries()) {
      if (!next.has(fold(column.name))) changes.push({ _tag: "ColumnRemoved", column, position });
    }
    for (const [position, column] of after.columns.entries()) {
      const old = previous.get(fold(column.name));
      if (!old) {
        changes.push({ _tag: "ColumnAdded", column, position });
        continue;
      }
      const fields: ("typeName" | "constraints")[] = [];
      if (old.typeName !== column.typeName) fields.push("typeName");
      const oldConstraints = yield* Effect.forEach(old.constraints, columnConstraint.encode);
      const newConstraints = yield* Effect.forEach(column.constraints, columnConstraint.encode);
      if (!equal(oldConstraints, newConstraints)) fields.push("constraints");
      if (fields.length)
        changes.push({ _tag: "ColumnChanged", before: old, after: column, fields });
    }
    const oldOrder = before.columns
      .filter((column) => next.has(fold(column.name)))
      .map((column) => fold(column.name));
    const newOrder = after.columns
      .filter((column) => previous.has(fold(column.name)))
      .map((column) => fold(column.name));
    if (!equal(oldOrder, newOrder))
      changes.push({ _tag: "ColumnOrderChanged", before: oldOrder, after: newOrder });
    const oldConstraints = yield* Effect.forEach(before.tableConstraints, tableConstraint.encode);
    const newConstraints = yield* Effect.forEach(after.tableConstraints, tableConstraint.encode);
    if (!equal(oldConstraints, newConstraints))
      changes.push({
        _tag: "TableConstraintsChanged",
        before: before.tableConstraints,
        after: after.tableConstraints,
      });
    const options = (table: CreateTable) =>
      (["STRICT", "WITHOUT ROWID"] as const).filter((option) => table.options?.includes(option));
    if (!equal(options(before), options(after)))
      changes.push({
        _tag: "TableOptionsChanged",
        before: before.options ?? [],
        after: after.options ?? [],
      });
    return changes;
  });

/** Structural schema comparison; no SQL execution, rename inference or migration planning. */
export const diffSchemas = (
  before: readonly Statement[],
  after: readonly Statement[],
): Effect.Effect<SchemaDiff, SchemaDiffError | EncodeError> =>
  Effect.gen(function* () {
    const diagnostics: DiffDiagnostic[] = [];
    const previous = indexSchema(before, "before", diagnostics);
    const next = indexSchema(after, "after", diagnostics);
    if (diagnostics.length) return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    // Validate constructed ASTs too, including tables added or removed wholesale.
    yield* Effect.forEach([...before, ...after], createTable.encode, { discard: true });
    const changes: TableChange[] = [];
    for (const [id, table] of previous) {
      if (!next.has(id))
        changes.push({ _tag: "TableRemoved", table: identity(table), definition: table });
    }
    for (const [id, table] of next) {
      const old = previous.get(id);
      if (!old) changes.push({ _tag: "TableAdded", table: identity(table), definition: table });
      else {
        const alterations = yield* compareTable(old, table);
        if (alterations.length)
          changes.push({
            _tag: "TableChanged",
            table: identity(table),
            before: old,
            after: table,
            changes: alterations,
          });
      }
    }
    return { changes };
  });
