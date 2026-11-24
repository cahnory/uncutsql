import { planViewOperations, viewsFromDatabaseSchema } from "./views.ts";
import { createView, type CreateView } from "./codecs/create-view.ts";
import { identifier } from "./codecs/identifier.ts";
import { createIndex, type CreateIndex } from "./codecs/create-index.ts";
import { indexesFromDatabaseSchema } from "./indexes.ts";
import { Data, Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import {
  createTable,
  columnDefinition,
  type ColumnDefinition,
  type CreateTable,
} from "./create-table.ts";
import {
  encodeRebuild,
  rebuildCopy,
  qualifiedTable as qualified,
  sqlString,
  type RebuildTableOperation,
} from "./rebuild.ts";
import { resolveProcedures } from "./procedures.ts";
import type { SchemaDiffError, DatabaseSchema, DatabaseMigration } from "@uncutsql/core";
import type { TableIdentity } from "./schema-identity.ts";
import { tablesFromDatabaseSchema } from "./database.ts";
import { foldIdentifier, tableIdentity, tableKey } from "./schema-identity.ts";
import type { Expression } from "./codecs/expression.ts";

export type MigrationOperation =
  | { readonly _tag: "DropView"; readonly table: TableIdentity }
  | { readonly _tag: "VerifyView"; readonly table: TableIdentity }
  | { readonly _tag: "CreateView"; readonly table: TableIdentity; readonly definition: CreateView }
  | {
      readonly _tag: "CheckDrop";
      readonly table: TableIdentity;
      readonly column?: string;
      readonly scratch: TableIdentity;
    }
  | {
      readonly _tag: "CreateIndex";
      readonly table: TableIdentity;
      readonly definition: CreateIndex;
    }
  | { readonly _tag: "DropIndex"; readonly table: TableIdentity; readonly index: TableIdentity }
  | { readonly _tag: "RenameTable"; readonly table: TableIdentity; readonly target: string }
  | RebuildTableOperation
  | { readonly _tag: "CreateTable"; readonly definition: CreateTable }
  | { readonly _tag: "DropTable"; readonly table: TableIdentity }
  | {
      readonly _tag: "AddColumn";
      readonly table: TableIdentity;
      readonly column: ColumnDefinition;
    };

export interface MigrationDiagnostic {
  readonly code: "UnsupportedRowCopy" | "RetainedForeignKey" | "ForeignKeyCycle";
  readonly table: TableIdentity;
  readonly column?: string;
  readonly message: string;
}

export class MigrationPlanError extends Data.TaggedError("MigrationPlanError")<{
  readonly diagnostics: readonly MigrationDiagnostic[];
}> {
  override get message(): string {
    return this.diagnostics.map((item) => `${tableKey(item.table)}: ${item.message}`).join("\n");
  }
}

export interface MigrationWarning {
  readonly code: "TableDataLoss" | "ColumnDataLoss";
  readonly table: TableIdentity;
  readonly message: string;
}

export interface MigrationPlan {
  readonly operations: readonly MigrationOperation[];
  readonly guardTable?: TableIdentity;
  readonly warnings: readonly MigrationWarning[];
}

const references = (table: CreateTable): readonly TableIdentity[] => {
  const schema = tableIdentity(table).schema;
  const names = [
    ...table.columns.flatMap((column) =>
      column.constraints.flatMap((constraint) =>
        constraint._tag === "References" ? [constraint.references.table] : [],
      ),
    ),
    ...table.tableConstraints.flatMap((constraint) =>
      constraint._tag === "ForeignKey" ? [constraint.references.table] : [],
    ),
  ];
  return names.map((name) => ({ schema, name: foldIdentifier(name) }));
};

const literalDefault = (value: Expression): boolean => {
  switch (value._tag) {
    case "NumericLiteral":
    case "StringLiteral":
    case "BlobLiteral":
    case "NullLiteral":
      return true;
    case "UnaryExpression":
      return (
        (value.operator === "+" || value.operator === "-") &&
        value.operand._tag === "NumericLiteral"
      );
    default:
      return false;
  }
};

const unsupportedColumn = (column: ColumnDefinition): string | undefined => {
  const unsupported = column.constraints.find(
    (constraint) =>
      constraint._tag !== "Default" &&
      constraint._tag !== "NotNull" &&
      constraint._tag !== "Collate",
  );
  if (unsupported)
    return `Adding a column with ${unsupported._tag} is not supported by this planner`;
  const defaults = column.constraints.filter((constraint) => constraint._tag === "Default");
  if (defaults.length > 1)
    return "Adding a column with repeated DEFAULT constraints is not supported";
  const value = defaults[0]?.value;
  if (value && !literalDefault(value))
    return "ADD COLUMN requires a literal default or a signed numeric default";
  if (
    column.constraints.some((constraint) => constraint._tag === "NotNull") &&
    (!value || value._tag === "NullLiteral")
  ) {
    return "A new NOT NULL column requires a non-NULL literal default for existing rows";
  }
  return undefined;
};

/** Lower caller-supplied logical procedures; comparison and logical planning belong to the caller. */
export const lowerMigration = (
  procedures: DatabaseMigration,
  previous: DatabaseSchema,
  next: DatabaseSchema,
): Effect.Effect<MigrationPlan, SchemaDiffError | EncodeError | MigrationPlanError> =>
  Effect.gen(function* () {
    if (previous.triggers?.length || next.triggers?.length)
      return yield* Effect.fail(
        new EncodeError({ message: "SQLite trigger snapshots are not supported yet" }),
      );
    const before = yield* tablesFromDatabaseSchema(previous);
    const after = yield* tablesFromDatabaseSchema(next);
    const beforeViews = yield* viewsFromDatabaseSchema(previous);
    const afterViews = yield* viewsFromDatabaseSchema(next);
    const beforeIndexes = yield* indexesFromDatabaseSchema(previous);
    const afterIndexes = yield* indexesFromDatabaseSchema(next);
    const indexesFor = (indexes: readonly CreateIndex[], table: TableIdentity) =>
      indexes.filter(
        (index) =>
          foldIdentifier(index.schema ?? "main") === table.schema &&
          foldIdentifier(index.table) === table.name,
      );
    const changes = yield* resolveProcedures(procedures, before, after);
    const diagnostics: MigrationDiagnostic[] = [];
    const drops = changes.filter((change) => change._tag === "DropTable");
    const dropped = new Set(drops.map((change) => tableKey(change.table)));
    const renamed = new Map<string, string>();
    for (const change of changes) {
      if (change._tag === "RenameTable")
        renamed.set(tableKey(tableIdentity(change.before)), change.after.name);
    }
    for (const table of after) {
      for (const reference of references(table)) {
        const key = tableKey(reference);
        const target = renamed.get(key);
        if (target === undefined && !dropped.has(key)) continue;
        diagnostics.push({
          code: "RetainedForeignKey",
          table: tableIdentity(table),
          message:
            target === undefined
              ? `The desired schema still references table ${key}, which is scheduled for removal`
              : `The foreign key still references ${JSON.stringify(reference.name)}, which is being renamed to ${JSON.stringify(target)}. Update REFERENCES in the desired schema and refresh the review with --merge-decisions.`,
        });
      }
    }
    const operations: MigrationOperation[] = [];
    const warnings: MigrationWarning[] = [];
    const reserved = new Set(
      [...before, ...after, ...beforeViews, ...afterViews].map((table) =>
        tableKey(tableIdentity(table)),
      ),
    );
    for (const index of [...beforeIndexes, ...afterIndexes])
      reserved.add(
        tableKey({
          schema: foldIdentifier(index.schema ?? "main"),
          name: foldIdentifier(index.name),
        }),
      );
    const allocate = (schema: string, prefix: string) => {
      let index = 0;
      let name = prefix;
      while (reserved.has(tableKey({ schema, name }))) name = `${prefix}_${++index}`;
      reserved.add(tableKey({ schema, name }));
      return name;
    };
    // Drop children before parents. Cyclic and self-referential drops need a later strategy.
    const pending = [...drops];
    while (pending.length) {
      const index = pending.findIndex(
        (candidate) =>
          !pending.some((other) =>
            references(other.definition).some(
              (reference) => tableKey(reference) === tableKey(candidate.table),
            ),
          ),
      );
      if (index < 0) {
        for (const change of pending)
          diagnostics.push({
            code: "ForeignKeyCycle",
            table: change.table,
            message: "Removing cyclic or self-referencing tables is not supported",
          });
        break;
      }
      const [change] = pending.splice(index, 1);
      operations.push({ _tag: "DropTable", table: change!.table });
      warnings.push({
        code: "TableDataLoss",
        table: change!.table,
        message: `Dropping table ${tableKey(change!.table)} removes all its data.`,
      });
    }
    for (const change of changes) {
      if (change._tag === "RenameTable")
        operations.push({
          _tag: "RenameTable",
          table: tableIdentity(change.before),
          target: change.after.name,
        });
    }
    for (const change of changes) {
      if (change._tag === "CreateTable") {
        // Make placement explicit; never conceal baseline drift with IF NOT EXISTS.
        operations.push({
          _tag: "CreateTable",
          definition: {
            ...change.definition,
            schema: change.table.schema,
            temporary: false,
            ifNotExists: false,
          },
        });
      } else if (change._tag === "AlterTable" || change._tag === "RenameTable") {
        const rebuild =
          change.changes.some(
            (item) => item._tag !== "ColumnAdded" && !item._tag.startsWith("Index"),
          ) ||
          change.before.columns.some(
            (column, index) =>
              foldIdentifier(column.name) !==
              foldIdentifier(change.after.columns[index]?.name ?? ""),
          );
        const additions = change.changes.filter((item) => item._tag === "ColumnAdded");
        if (rebuild || additions.some((item) => unsupportedColumn(item.column))) {
          const renames = change.changes
            .filter((item) => item._tag === "ColumnRenamed")
            .map((item) => ({ source: item.before.name, target: item.after.name }));
          const copy = rebuildCopy(change.before, change.after, renames);
          if (typeof copy === "string") {
            diagnostics.push({ code: "UnsupportedRowCopy", table: change.table, message: copy });
            continue;
          }
          operations.push({
            _tag: "RebuildTable",
            table: change.table,
            before: change.before,
            after: change.after,
            temporaryName: allocate(change.table.schema, "__uncutsql_rebuild"),
            indexesBefore: indexesFor(beforeIndexes, tableIdentity(change.before)),
            ...(renames.length ? { renames } : {}),
          });
          const removed = change.changes.filter((item) => item._tag === "ColumnRemoved");
          if (removed.length)
            warnings.push({
              code: "ColumnDataLoss",
              table: change.table,
              message: `Rebuilding ${tableKey(change.table)} removes column data: ${removed.map((item) => JSON.stringify(item.column.name)).join(", ")}.`,
            });
        } else {
          for (const item of additions)
            operations.push({ _tag: "AddColumn", table: change.table, column: item.column });
        }
      }
    }
    const indexDrops = new Map<string, Extract<MigrationOperation, { _tag: "DropIndex" }>>();
    const indexCreates = new Map<string, Extract<MigrationOperation, { _tag: "CreateIndex" }>>();
    const rebuilt = new Set(
      operations
        .filter((operation) => operation._tag === "RebuildTable")
        .map((operation) => tableKey(operation.table)),
    );
    for (const procedure of procedures.procedures) {
      if ("trigger" in procedure || procedure._tag === "ReplaceTrigger") continue;
      if ("view" in procedure || procedure._tag === "ReplaceView") continue;
      const model = "after" in procedure ? procedure.after : procedure.table;
      const table = { schema: model.identity.catalog!, name: model.identity.name };
      const source = "before" in procedure ? procedure.before.identity : model.identity;
      const old = indexesFor(beforeIndexes, { schema: source.catalog!, name: source.name }),
        desired = indexesFor(afterIndexes, table);
      const drop = (index: CreateIndex) => {
        const identity = { schema: table.schema, name: foldIdentifier(index.name) };
        indexDrops.set(tableKey(identity), { _tag: "DropIndex", table, index: identity });
      };
      const create = (index: CreateIndex) =>
        indexCreates.set(tableKey({ schema: table.schema, name: foldIdentifier(index.name) }), {
          _tag: "CreateIndex",
          table,
          definition: { ...index, ifNotExists: false },
        });
      if (procedure._tag === "DropTable" || rebuilt.has(tableKey(table))) old.forEach(drop);
      if (procedure._tag === "CreateTable" || rebuilt.has(tableKey(table))) desired.forEach(create);
      if ("changes" in procedure && !rebuilt.has(tableKey(table)))
        for (const change of procedure.changes) {
          if (change._tag === "IndexRemoved" || change._tag === "IndexChanged") {
            const key = change._tag === "IndexRemoved" ? change.index.key : change.before.key;
            const index = old.find((index) => foldIdentifier(index.name) === key);
            if (!index)
              return yield* Effect.fail(
                new EncodeError({ message: "Index removal does not match the database context" }),
              );
            drop(index);
          }
          if (change._tag === "IndexAdded" || change._tag === "IndexChanged") {
            const key = change._tag === "IndexAdded" ? change.index.key : change.after.key;
            const index = desired.find((index) => foldIdentifier(index.name) === key);
            if (!index)
              return yield* Effect.fail(
                new EncodeError({ message: "Index creation does not match the database context" }),
              );
            create(index);
          }
        }
    }
    const affectedSchemas = new Set(
      operations.flatMap((op) =>
        op._tag === "RebuildTable" || op._tag === "RenameTable" ? [op.table.schema, "temp"] : [],
      ),
    );
    const viewSteps = yield* planViewOperations(
      procedures,
      beforeViews,
      afterViews,
      affectedSchemas,
    );
    const guards = (procedures.dropGuards ?? []).map((guard): MigrationOperation => ({
      _tag: "CheckDrop",
      table: { schema: guard.table.catalog ?? "main", name: guard.table.name },
      ...(guard.column !== undefined ? { column: guard.column } : {}),
      scratch: { schema: "temp", name: allocate("temp", "__uncutsql_drop_guard") },
    }));
    operations.unshift(...guards, ...viewSteps.drops, ...indexDrops.values());
    operations.push(...indexCreates.values(), ...viewSteps.creates);
    if (operations.length)
      for (const view of viewSteps.retained)
        operations.push({ _tag: "VerifyView", table: tableIdentity(view) });
    if (diagnostics.length) return yield* Effect.fail(new MigrationPlanError({ diagnostics }));
    const guardTable = operations.some(
      (operation) => operation._tag === "RebuildTable" || operation._tag === "DropView",
    )
      ? { schema: "temp", name: allocate("temp", "__uncutsql_migration_guard") }
      : undefined;
    return { operations, warnings, ...(guardTable ? { guardTable } : {}) };
  });

/** Render a plan without executing it. Rebuilds temporarily disable foreign keys. */
export const encodeMigration = (plan: MigrationPlan): Effect.Effect<string, EncodeError> =>
  Effect.gen(function* () {
    const statements = yield* Effect.forEach(plan.operations, (operation) =>
      Effect.gen(function* () {
        switch (operation._tag) {
          case "CheckDrop": {
            const table = yield* qualified(operation.table);
            const scratch = yield* qualified(operation.scratch);
            const column =
              operation.column === undefined
                ? undefined
                : yield* identifier.encode(operation.column);
            const source = column === undefined ? table : `${table}.${column}`;
            const constraint = yield* identifier.encode(`drop_if_empty: ${source} contains data`);
            const predicate = column === undefined ? "" : ` WHERE ${source} IS NOT NULL`;
            return [
              `CREATE TABLE ${scratch} (violation INTEGER CONSTRAINT ${constraint} CHECK (violation = 0));`,
              `INSERT OR ROLLBACK INTO ${scratch} SELECT 1 FROM ${table}${predicate} LIMIT 1;`,
              `DROP TABLE ${scratch};`,
            ].join("\n");
          }
          case "CreateView":
            return yield* createView.encode(operation.definition);
          case "DropView":
            return `DROP VIEW ${yield* qualified(operation.table)};`;
          case "VerifyView":
            return `SELECT * FROM ${yield* qualified(operation.table)} LIMIT 0;`;
          case "CreateIndex":
            return yield* createIndex.encode(operation.definition);
          case "DropIndex":
            return `DROP INDEX ${yield* qualified(operation.index)};`;
          case "RebuildTable":
            return yield* encodeRebuild(operation);
          case "CreateTable":
            return yield* createTable.encode(operation.definition);
          case "RenameTable":
            return `ALTER TABLE ${yield* qualified(operation.table)} RENAME TO ${yield* identifier.encode(operation.target)};`;
          case "DropTable":
            return `DROP TABLE ${yield* qualified(operation.table)};`;
          case "AddColumn": {
            const reason = unsupportedColumn(operation.column);
            if (reason) return yield* Effect.fail(new EncodeError({ message: reason }));
            return `ALTER TABLE ${yield* qualified(operation.table)} ADD COLUMN ${yield* columnDefinition.encode(operation.column)};`;
          }
          default:
            return yield* Effect.fail(
              new EncodeError({ message: "Unsupported migration operation" }),
            );
        }
      }),
    );
    if (!statements.length) return "";
    const warnings = plan.warnings.map(
      (warning) => `-- WARNING: ${warning.message.replace(/[\r\n]/g, " ")}`,
    );
    const rebuilds = plan.operations.filter((operation) => operation._tag === "RebuildTable");
    const begin = plan.operations.some((operation) => operation._tag === "CheckDrop")
      ? "BEGIN IMMEDIATE;"
      : "BEGIN;";
    const droppedViews = plan.operations.filter((op) => op._tag === "DropView");
    if (!rebuilds.length && !droppedViews.length)
      return [...warnings, begin, ...statements, "COMMIT;"].join("\n");
    if (!plan.guardTable)
      return yield* Effect.fail(
        new EncodeError({ message: "A rebuild plan requires a guard table" }),
      );
    const guard = yield* qualified(plan.guardTable);
    const preflight: string[] = [];
    for (const view of droppedViews) {
      const name = yield* sqlString(view.table.name);
      for (const schema of new Set([view.table.schema, "temp"])) {
        const catalog = yield* qualified({ schema, name: "sqlite_schema" });
        preflight.push(
          `INSERT OR ROLLBACK INTO ${guard} SELECT count(*) FROM ${catalog} WHERE type = 'trigger' AND tbl_name = ${name} COLLATE NOCASE;`,
        );
      }
    }
    const unknownViews = (schema: string) =>
      Effect.gen(function* () {
        const known = yield* Effect.forEach(
          droppedViews.filter((view) => view.table.schema === schema),
          (view) => sqlString(view.table.name),
        );
        return known.length
          ? `(type = 'view' AND name COLLATE NOCASE NOT IN (${known.join(", ")}))`
          : "type = 'view'";
      });
    for (const operation of rebuilds) {
      const catalog = yield* qualified({ ...operation.table, name: "sqlite_schema" });
      const name = yield* sqlString(operation.before.name);
      const known = yield* Effect.forEach(operation.indexesBefore ?? [], (index) =>
        sqlString(index.name),
      );
      const unknownIndex = known.length
        ? ` AND name COLLATE NOCASE NOT IN (${known.join(", ")})`
        : "";
      preflight.push(
        `INSERT OR ROLLBACK INTO ${guard} SELECT count(*) FROM ${catalog} WHERE ${yield* unknownViews(operation.table.schema)} OR (tbl_name = ${name} COLLATE NOCASE AND (type = 'trigger' OR (type = 'index' AND sql IS NOT NULL${unknownIndex})));`,
      );
      if (known.length)
        preflight.push(
          `INSERT OR ROLLBACK INTO ${guard} SELECT abs(count(*) - ${known.length}) FROM ${catalog} WHERE type = 'index' AND sql IS NOT NULL AND tbl_name = ${name} COLLATE NOCASE AND name COLLATE NOCASE IN (${known.join(", ")});`,
        );
      preflight.push(
        `INSERT OR ROLLBACK INTO ${guard} SELECT count(*) FROM temp.sqlite_schema WHERE ${yield* unknownViews("temp")} OR (type = 'trigger' AND tbl_name = ${name} COLLATE NOCASE);`,
      );
    }
    if (!rebuilds.length)
      return [
        ...warnings,
        begin,
        `CREATE TABLE ${guard} (violations INTEGER CHECK (violations = 0));`,
        ...preflight,
        ...statements,
        `DROP TABLE ${guard};`,
        "COMMIT;",
      ].join("\n");
    const schemas = new Set(
      plan.operations.map((operation) =>
        operation._tag === "CreateTable"
          ? tableIdentity(operation.definition).schema
          : operation.table.schema,
      ),
    );
    const checks = yield* Effect.forEach([...schemas], (schema) =>
      Effect.map(
        sqlString(schema),
        (name) =>
          `INSERT OR ROLLBACK INTO ${guard} SELECT count(*) FROM pragma_foreign_key_check(NULL, ${name});`,
      ),
    );
    return [
      ...warnings,
      "-- Rebuild: run outside a transaction; stop on error, roll back and restore foreign_keys=ON.",
      "PRAGMA foreign_keys=OFF;",
      begin,
      `CREATE TABLE ${guard} (violations INTEGER CHECK (violations = 0));`,
      ...preflight,
      ...statements,
      ...checks,
      `DROP TABLE ${guard};`,
      "COMMIT;",
      "PRAGMA foreign_keys=ON;",
    ].join("\n");
  });
