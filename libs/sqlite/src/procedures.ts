import { Effect } from "effect";

import { EncodeError } from "@uncutsql/codec";
import type { DatabaseMigration, TableAlteration } from "@uncutsql/core";

import type { ColumnDefinition, CreateTable } from "./create-table.ts";
import { foldIdentifier, tableIdentity, tableKey } from "./schema-identity.ts";
import type { TableIdentity } from "./schema-identity.ts";

type NativeAlteration =
  | {
      readonly _tag: "ColumnRenamed";
      readonly after: ColumnDefinition;
      readonly before: ColumnDefinition;
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
      readonly definition: CreateTable;
      readonly table: TableIdentity;
    }
  | { readonly _tag: "DropTable"; readonly definition: CreateTable; readonly table: TableIdentity }
  | {
      readonly _tag: "AlterTable" | "RenameTable";
      readonly after: CreateTable;
      readonly before: CreateTable;
      readonly changes: readonly NativeAlteration[];
      readonly table: TableIdentity;
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
      if ("trigger" in procedure || procedure._tag === "ReplaceTrigger") {
        continue;
      }
      if ("view" in procedure || procedure._tag === "ReplaceView") {
        continue;
      }
      const identity = "after" in procedure ? procedure.after.identity : procedure.table.identity;
      const table = { name: identity.name, schema: identity.catalog ?? "" };
      const source = procedure._tag === "RenameTable" ? procedure.before.identity : identity;
      if (source.catalog !== identity.catalog || source.schema !== identity.schema) {
        return yield* Effect.fail(
          new EncodeError({ message: "Cannot rename a table across schemas" }),
        );
      }
      const old = previous.get(tableKey({ name: source.name, schema: source.catalog ?? "" }));
      const target = next.get(tableKey(table));
      if (procedure._tag === "CreateTable" || procedure._tag === "DropTable") {
        const definition = procedure._tag === "CreateTable" ? target : old;
        if (!definition) {
          return yield* Effect.fail(
            new EncodeError({
              message: "Migration procedure refers to a table absent from its database context",
            }),
          );
        }
        procedures.push({ _tag: procedure._tag, definition, table });
        continue;
      }
      if (!old || !target) {
        return yield* Effect.fail(
          new EncodeError({ message: "AlterTable requires both source and target definitions" }),
        );
      }
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
          ) {
            return yield* Effect.fail(
              new EncodeError({ message: "Rename decision does not match its database context" }),
            );
          }
          changes.push({ _tag: "ColumnRenamed", after: destination, before: source });
        } else if (change._tag === "ColumnAdded" || change._tag === "ColumnRemoved") {
          const column = (change._tag === "ColumnAdded" ? target : old).columns[change.position];
          if (!column || column.name !== change.column.name) {
            return yield* Effect.fail(
              new EncodeError({ message: "Column procedure does not match its database context" }),
            );
          }
          changes.push({ _tag: change._tag, column, position: change.position });
        } else {
          changes.push({ _tag: change._tag });
        }
      }
      procedures.push({ _tag: procedure._tag, after: target, before: old, changes, table });
    }
    return procedures;
  });
