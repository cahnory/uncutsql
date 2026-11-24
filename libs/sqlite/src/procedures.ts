import { Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import type { DatabaseMigration, TableAlteration } from "@uncutsql/core";
import type { CreateTable, ColumnDefinition } from "./create-table.ts";
import { foldIdentifier, tableIdentity, tableKey, type TableIdentity } from "./schema-identity.ts";

type NativeAlteration =
  | {
      readonly _tag: "ColumnRenamed";
      readonly before: ColumnDefinition;
      readonly after: ColumnDefinition;
    }
  | { readonly _tag: "ColumnAdded"; readonly column: ColumnDefinition; readonly position: number }
  | { readonly _tag: "ColumnRemoved"; readonly column: ColumnDefinition; readonly position: number }
  | {
      readonly _tag: Exclude<
        TableAlteration["_tag"],
        "ColumnAdded" | "ColumnRemoved" | "ColumnRenamed"
      >;
    };

type NativeProcedure =
  | {
      readonly _tag: "CreateTable";
      readonly table: TableIdentity;
      readonly definition: CreateTable;
    }
  | { readonly _tag: "DropTable"; readonly table: TableIdentity; readonly definition: CreateTable }
  | {
      readonly _tag: "AlterTable" | "RenameTable";
      readonly table: TableIdentity;
      readonly before: CreateTable;
      readonly after: CreateTable;
      readonly changes: readonly NativeAlteration[];
    };

/** Resolve caller-supplied procedures into native definitions, without comparing schemas. */
export const resolveProcedures = (
  migration: DatabaseMigration,
  before: readonly CreateTable[],
  after: readonly CreateTable[],
): Effect.Effect<readonly NativeProcedure[], EncodeError> =>
  Effect.gen(function* () {
    const previous = new Map(before.map((table) => [tableKey(tableIdentity(table)), table]));
    const next = new Map(after.map((table) => [tableKey(tableIdentity(table)), table]));
    const procedures: NativeProcedure[] = [];
    for (const procedure of migration.procedures) {
      const identity = "after" in procedure ? procedure.after.identity : procedure.table.identity;
      const table = { schema: identity.catalog ?? "", name: identity.name };
      const source = procedure._tag === "RenameTable" ? procedure.before.identity : identity;
      if (source.catalog !== identity.catalog || source.schema !== identity.schema)
        return yield* Effect.fail(
          new EncodeError({ message: "Cannot rename a table across schemas" }),
        );
      const old = previous.get(tableKey({ schema: source.catalog ?? "", name: source.name }));
      const target = next.get(tableKey(table));
      if (procedure._tag === "CreateTable" || procedure._tag === "DropTable") {
        const definition = procedure._tag === "CreateTable" ? target : old;
        if (!definition)
          return yield* Effect.fail(
            new EncodeError({
              message: "Migration procedure refers to a table absent from its database context",
            }),
          );
        procedures.push({ _tag: procedure._tag, table, definition });
        continue;
      }
      if (!old || !target)
        return yield* Effect.fail(
          new EncodeError({ message: "AlterTable requires both source and target definitions" }),
        );
      const changes: NativeAlteration[] = [];
      for (const change of procedure.changes) {
        if (change._tag === "ColumnRenamed") {
          const source = old.columns.find(
            (column) => foldIdentifier(column.name) === change.before.key,
          );
          const destination = target.columns.find(
            (column) => foldIdentifier(column.name) === change.after.key,
          );
          if (
            !source ||
            !destination ||
            source.name !== change.before.name ||
            destination.name !== change.after.name
          )
            return yield* Effect.fail(
              new EncodeError({ message: "Rename decision does not match its database context" }),
            );
          changes.push({ _tag: "ColumnRenamed", before: source, after: destination });
        } else if (change._tag === "ColumnAdded" || change._tag === "ColumnRemoved") {
          const column = (change._tag === "ColumnAdded" ? target : old).columns[change.position];
          if (!column || column.name !== change.column.name)
            return yield* Effect.fail(
              new EncodeError({ message: "Column procedure does not match its database context" }),
            );
          changes.push({ _tag: change._tag, position: change.position, column });
        } else changes.push({ _tag: change._tag });
      }
      procedures.push({ _tag: procedure._tag, table, before: old, after: target, changes });
    }
    return procedures;
  });
