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
import { fromDatabaseSchema } from "./database.ts";
import { foldIdentifier, tableIdentity, tableKey } from "./schema-identity.ts";
import type { Expression } from "./codecs/expression.ts";

export type MigrationOperation =
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
    const before = yield* fromDatabaseSchema(previous);
    const after = yield* fromDatabaseSchema(next);
    const changes = yield* resolveProcedures(procedures, before, after);
    const diagnostics: MigrationDiagnostic[] = [];
    const drops = changes.filter((change) => change._tag === "DropTable");
    const dropped = new Set(drops.map((change) => tableKey(change.table)));
    for (const table of after) {
      if (references(table).some((reference) => dropped.has(tableKey(reference))))
        diagnostics.push({
          code: "RetainedForeignKey",
          table: tableIdentity(table),
          message: "The desired schema still references a table scheduled for removal",
        });
    }
    const operations: MigrationOperation[] = [];
    const warnings: MigrationWarning[] = [];
    const reserved = new Set([...before, ...after].map((table) => tableKey(tableIdentity(table))));
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
      } else if (change._tag === "AlterTable") {
        const rebuild =
          change.changes.some((item) => item._tag !== "ColumnAdded") ||
          change.before.columns.some(
            (column, index) =>
              foldIdentifier(column.name) !==
              foldIdentifier(change.after.columns[index]?.name ?? ""),
          );
        const additions = change.changes.filter((item) => item._tag === "ColumnAdded");
        if (rebuild || additions.some((item) => unsupportedColumn(item.column))) {
          const copy = rebuildCopy(change.before, change.after);
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
    if (diagnostics.length) return yield* Effect.fail(new MigrationPlanError({ diagnostics }));
    const guardTable = operations.some((operation) => operation._tag === "RebuildTable")
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
          case "RebuildTable":
            return yield* encodeRebuild(operation);
          case "CreateTable":
            return yield* createTable.encode(operation.definition);
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
    if (!rebuilds.length) return [...warnings, "BEGIN;", ...statements, "COMMIT;"].join("\n");
    if (!plan.guardTable)
      return yield* Effect.fail(
        new EncodeError({ message: "A rebuild plan requires a guard table" }),
      );
    const guard = yield* qualified(plan.guardTable);
    const preflight: string[] = [];
    for (const operation of rebuilds) {
      const catalog = yield* qualified({ ...operation.table, name: "sqlite_schema" });
      const name = yield* sqlString(operation.before.name);
      preflight.push(
        `INSERT OR ROLLBACK INTO ${guard} SELECT count(*) FROM ${catalog} WHERE type = 'view' OR (tbl_name = ${name} COLLATE NOCASE AND (type = 'trigger' OR (type = 'index' AND sql IS NOT NULL)));`,
      );
      preflight.push(
        `INSERT OR ROLLBACK INTO ${guard} SELECT count(*) FROM temp.sqlite_schema WHERE type = 'view' OR (type = 'trigger' AND tbl_name = ${name} COLLATE NOCASE);`,
      );
    }
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
      "BEGIN;",
      `CREATE TABLE ${guard} (violations INTEGER CHECK (violations = 0));`,
      ...preflight,
      ...statements,
      ...checks,
      `DROP TABLE ${guard};`,
      "COMMIT;",
      "PRAGMA foreign_keys=ON;",
    ].join("\n");
  });
