import { Effect, Result } from "effect";
import type { EncodeError } from "@uncutsql/codec";
import {
  diffDatabases,
  SchemaDiffError,
  type DatabaseDiff,
  type DiffDiagnostic as CoreDiagnostic,
  type DatabaseSchema,
  type DatabaseMigration,
} from "@uncutsql/core";
import { type CreateTable, type ColumnDefinition } from "./create-table.ts";
import type { TableConstraint } from "./codecs/table-constraint.ts";
import type { TableOption } from "./codecs/table-options.ts";
import type { Statement } from "./schema.ts";
import { toDatabaseSchema } from "./database.ts";
import { tableIdentity as identity, tableKey as key } from "./schema-identity.ts";

export { SchemaDiffError } from "@uncutsql/core";
export type { DiffDiagnostic } from "@uncutsql/core";

export interface TableIdentity {
  readonly schema: string;
  readonly name: string;
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

/** Adapt both inputs, aggregating dialect and shared validation diagnostics. */
export const compareSchemas = (
  before: readonly Statement[],
  after: readonly Statement[],
): Effect.Effect<
  { readonly before: DatabaseSchema; readonly after: DatabaseSchema; readonly diff: DatabaseDiff },
  SchemaDiffError | EncodeError
> =>
  Effect.gen(function* () {
    const diagnostics: CoreDiagnostic[] = [];
    const databases: DatabaseSchema[] = [];
    for (const [statements, side] of [
      [before, "before"],
      [after, "after"],
    ] as const) {
      const result = yield* Effect.result(toDatabaseSchema(statements, side));
      if (Result.isSuccess(result)) databases.push(result.success);
      else if (result.failure instanceof SchemaDiffError)
        diagnostics.push(...result.failure.diagnostics);
      else return yield* Effect.fail(result.failure);
    }
    if (diagnostics.length) return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    const diff = yield* diffDatabases(databases[0]!, databases[1]!);
    return { before: databases[0]!, after: databases[1]!, diff };
  });

/** Preserve the SQLite report shape while comparison lives entirely in core. */
export const sqliteDiff = (
  diff: DatabaseDiff,
  before: readonly Statement[],
  after: readonly Statement[],
): SchemaDiff => {
  const previous = new Map(before.map((table) => [key(identity(table)), table]));
  const next = new Map(after.map((table) => [key(identity(table)), table]));
  return {
    changes: diff.changes.map((change): TableChange => {
      const table = { schema: change.table.catalog!, name: change.table.name };
      if (change._tag === "TableAdded")
        return { _tag: change._tag, table, definition: next.get(key(table))! };
      if (change._tag === "TableRemoved")
        return { _tag: change._tag, table, definition: previous.get(key(table))! };
      const old = previous.get(key(table))!;
      const target = next.get(key(table))!;
      const changes = change.changes.map((item): TableAlteration => {
        switch (item._tag) {
          case "ColumnAdded":
            return { ...item, column: target.columns[item.position]! };
          case "ColumnRemoved":
            return { ...item, column: old.columns[item.position]! };
          case "ColumnChanged":
            return {
              _tag: item._tag,
              before: old.columns.find((column) => column.name === item.before.name)!,
              after: target.columns.find((column) => column.name === item.after.name)!,
              fields: item.fields.map((field) => (field === "dataType" ? "typeName" : field)),
            };
          case "ColumnOrderChanged":
            return item;
          case "TableConstraintsChanged":
            return {
              _tag: item._tag,
              before: old.tableConstraints,
              after: target.tableConstraints,
            };
          case "TableOptionsChanged":
            return { _tag: item._tag, before: old.options ?? [], after: target.options ?? [] };
        }
      });
      return { _tag: "TableChanged", table, before: old, after: target, changes };
    }),
  };
};

/** Resolve logical core procedures against the validated SQLite input definitions. */
export const sqliteProcedures = (
  migration: DatabaseMigration,
  before: readonly Statement[],
  after: readonly Statement[],
) => {
  const diff: DatabaseDiff = {
    changes: migration.procedures.map((procedure) => {
      switch (procedure._tag) {
        case "CreateTable":
          return {
            _tag: "TableAdded",
            table: procedure.table.identity,
            definition: procedure.table,
          };
        case "DropTable":
          return {
            _tag: "TableRemoved",
            table: procedure.table.identity,
            definition: procedure.table,
          };
        case "AlterTable":
          return {
            _tag: "TableChanged",
            table: procedure.after.identity,
            before: procedure.before,
            after: procedure.after,
            changes: procedure.changes,
          };
      }
    }),
  };
  return sqliteDiff(diff, before, after);
};

export const diffSchemas = (
  before: readonly Statement[],
  after: readonly Statement[],
): Effect.Effect<SchemaDiff, SchemaDiffError | EncodeError> =>
  Effect.map(compareSchemas(before, after), (comparison) =>
    sqliteDiff(comparison.diff, before, after),
  );
