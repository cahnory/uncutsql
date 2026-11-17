import { Data, Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import {
  createTable,
  columnDefinition,
  type ColumnDefinition,
  type CreateTable,
} from "./create-table.ts";
import { identifier } from "./codecs/identifier.ts";
import { diffSchemas, type SchemaDiffError, type TableIdentity } from "./diff.ts";
import { foldIdentifier, tableIdentity, tableKey } from "./schema-identity.ts";
import type { Statement } from "./schema.ts";
import type { Expression } from "./codecs/expression.ts";

export type MigrationOperation =
  | { readonly _tag: "CreateTable"; readonly definition: CreateTable }
  | { readonly _tag: "DropTable"; readonly table: TableIdentity }
  | {
      readonly _tag: "AddColumn";
      readonly table: TableIdentity;
      readonly column: ColumnDefinition;
    };

export interface MigrationDiagnostic {
  readonly code:
    | "TableRebuildRequired"
    | "UnsupportedAddColumn"
    | "RetainedForeignKey"
    | "ForeignKeyCycle";
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
  readonly code: "TableDataLoss";
  readonly table: TableIdentity;
  readonly message: string;
}

export interface MigrationPlan {
  readonly operations: readonly MigrationOperation[];
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

/** Plan a deliberately bounded subset; unsupported changes fail the entire plan. */
export const planMigration = (
  before: readonly Statement[],
  after: readonly Statement[],
): Effect.Effect<MigrationPlan, SchemaDiffError | EncodeError | MigrationPlanError> =>
  Effect.gen(function* () {
    const diff = yield* diffSchemas(before, after);
    const diagnostics: MigrationDiagnostic[] = [];
    const drops = diff.changes.filter((change) => change._tag === "TableRemoved");
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
    for (const change of diff.changes) {
      if (change._tag === "TableAdded") {
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
      } else if (change._tag === "TableChanged") {
        const rebuild =
          change.changes.some((item) => item._tag !== "ColumnAdded") ||
          change.before.columns.some(
            (column, index) =>
              foldIdentifier(column.name) !==
              foldIdentifier(change.after.columns[index]?.name ?? ""),
          );
        if (rebuild) {
          diagnostics.push({
            code: "TableRebuildRequired",
            table: change.table,
            message:
              "This table change requires a rebuild; only appended columns are currently supported",
          });
          continue;
        }
        for (const item of change.changes) {
          if (item._tag !== "ColumnAdded") continue;
          const reason = unsupportedColumn(item.column);
          if (reason)
            diagnostics.push({
              code: "UnsupportedAddColumn",
              table: change.table,
              column: item.column.name,
              message: reason,
            });
          else operations.push({ _tag: "AddColumn", table: change.table, column: item.column });
        }
      }
    }
    if (diagnostics.length) return yield* Effect.fail(new MigrationPlanError({ diagnostics }));
    return { operations, warnings };
  });

const qualified = (table: TableIdentity) =>
  Effect.gen(function* () {
    const schema = yield* identifier.encode(table.schema);
    const name = yield* identifier.encode(table.name);
    return `${schema}.${name}`;
  });

/** Render a plan as a transaction. No execution or PRAGMA changes occur here. */
export const encodeMigration = (plan: MigrationPlan): Effect.Effect<string, EncodeError> =>
  Effect.gen(function* () {
    const statements = yield* Effect.forEach(plan.operations, (operation) =>
      Effect.gen(function* () {
        switch (operation._tag) {
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
    return [...warnings, "BEGIN;", ...statements, "COMMIT;"].join("\n");
  });
