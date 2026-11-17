import { Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import type { DatabaseMigration, TableAlteration } from "@uncutsql/core";
import type { CreateTable, ColumnDefinition } from "./create-table.ts";
import type { Statement } from "./schema.ts";
import { tableIdentity, tableKey, type TableIdentity } from "./schema-identity.ts";

type NativeAlteration =
  | { readonly _tag: "ColumnAdded"; readonly column: ColumnDefinition; readonly position: number }
  | { readonly _tag: "ColumnRemoved"; readonly column: ColumnDefinition; readonly position: number }
  | { readonly _tag: Exclude<TableAlteration["_tag"], "ColumnAdded" | "ColumnRemoved"> };

type NativeProcedure =
  | {
      readonly _tag: "CreateTable";
      readonly table: TableIdentity;
      readonly definition: CreateTable;
    }
  | { readonly _tag: "DropTable"; readonly table: TableIdentity; readonly definition: CreateTable }
  | {
      readonly _tag: "AlterTable";
      readonly table: TableIdentity;
      readonly before: CreateTable;
      readonly after: CreateTable;
      readonly changes: readonly NativeAlteration[];
    };

/** Resolve caller-supplied procedures into native definitions, without comparing schemas. */
export const resolveProcedures = (
  migration: DatabaseMigration,
  before: readonly Statement[],
  after: readonly Statement[],
): Effect.Effect<readonly NativeProcedure[], EncodeError> =>
  Effect.gen(function* () {
    const previous = new Map(before.map((table) => [tableKey(tableIdentity(table)), table]));
    const next = new Map(after.map((table) => [tableKey(tableIdentity(table)), table]));
    const procedures: NativeProcedure[] = [];
    for (const procedure of migration.procedures) {
      const identity =
        procedure._tag === "AlterTable" ? procedure.after.identity : procedure.table.identity;
      const table = { schema: identity.catalog ?? "", name: identity.name };
      const old = previous.get(tableKey(table));
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
        if (change._tag === "ColumnAdded" || change._tag === "ColumnRemoved") {
          const column = (change._tag === "ColumnAdded" ? target : old).columns[change.position];
          if (!column || column.name !== change.column.name)
            return yield* Effect.fail(
              new EncodeError({ message: "Column procedure does not match its database context" }),
            );
          changes.push({ _tag: change._tag, position: change.position, column });
        } else changes.push({ _tag: change._tag });
      }
      procedures.push({ _tag: "AlterTable", table, before: old, after: target, changes });
    }
    return procedures;
  });
