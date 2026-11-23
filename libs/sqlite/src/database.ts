import { Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import {
  SchemaDiffError,
  validateDatabase,
  type Constraint,
  type DatabaseSchema,
  type DiffDiagnostic,
  type SchemaValue,
} from "@uncutsql/core";
import { createTable, type CreateTable } from "./create-table.ts";
import type { Statement } from "./schema.ts";
import { foldIdentifier, tableIdentity } from "./schema-identity.ts";

/** Structural semantic values, not source text or a parser AST. */
const semanticValue = (value: unknown): SchemaValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map(semanticValue);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key === "_tag" ? "kind" : key, semanticValue(item)]),
    );
  throw new TypeError("Schema model values must be serializable");
};
const constraint = (value: { readonly _tag: string }): Constraint => ({
  kind: value._tag,
  properties: Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => key !== "_tag" && item !== undefined)
      .map(([key, item]) => [key, semanticValue(item)]),
  ),
});

/** SQLite resolves identifiers, placement and vendor options; core receives normalized keys. */
export const toDatabaseSchema = (
  statements: readonly Statement[],
  side: DiffDiagnostic["side"] = "after",
) =>
  Effect.gen(function* () {
    const unsupported = statements.filter((statement) => statement._tag !== "CreateTable");
    if (unsupported.length)
      return yield* Effect.fail(
        new SchemaDiffError({
          diagnostics: unsupported.map((statement) => ({
            code: "UnsupportedSchemaStatement",
            side,
            table: {
              catalog: statement.schema ?? (statement.temporary ? "temp" : "main"),
              name: statement.name,
            },
            message:
              "CREATE TABLE AS queries require SQLite evaluation to determine columns and populate data; use an explicit table definition for declarative schema comparison",
          })),
        }),
      );
    const tables = statements.filter((statement) => statement._tag === "CreateTable");
    const database: DatabaseSchema = {
      tables: tables.map((table) => {
        const identity = tableIdentity(table);
        return {
          identity: { catalog: identity.schema, name: identity.name },
          name: table.name,
          columns: table.columns.map((column) => ({
            key: foldIdentifier(column.name),
            name: column.name,
            dataType: column.typeName ?? null,
            constraints: column.constraints.map(constraint),
          })),
          constraints: table.tableConstraints.map(constraint),
          options: Object.fromEntries(
            (["STRICT", "WITHOUT ROWID"] as const)
              .filter((option) => table.options?.includes(option))
              .map((option) => [`sqlite:${option}`, true]),
          ),
        };
      }),
    };
    const diagnostics = [...validateDatabase(database, side)];
    for (const table of tables) {
      const id = tableIdentity(table);
      if (table.temporary && id.schema !== "temp")
        diagnostics.push({
          code: "InvalidTemporarySchema",
          side,
          table: { catalog: id.schema, name: id.name },
          message: `TEMP table ${JSON.stringify([id.schema, id.name])} must use the temp schema`,
        });
    }
    if (diagnostics.length) return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    yield* Effect.forEach(tables, createTable.encode, { discard: true });
    return database;
  });

const syntaxValue = (value: SchemaValue): unknown => {
  if (Array.isArray(value)) return value.map(syntaxValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key === "kind" ? "_tag" : key,
        syntaxValue(item),
      ]),
    );
  return value;
};
const syntaxConstraint = (value: Constraint) => ({
  _tag: value.kind,
  ...Object.fromEntries(
    Object.entries(value.properties).map(([key, item]) => [key, syntaxValue(item)]),
  ),
});

/** Materialize SQLite-supported semantic models, including a JSON-restored baseline. */
export const fromDatabaseSchema = (
  database: DatabaseSchema,
): Effect.Effect<readonly CreateTable[], SchemaDiffError | EncodeError> =>
  Effect.gen(function* () {
    const diagnostics = validateDatabase(database, "after");
    if (diagnostics.length) return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    return yield* Effect.forEach(database.tables, (table) =>
      Effect.gen(function* () {
        if (
          table.identity.catalog === undefined ||
          table.identity.schema !== undefined ||
          table.identity.name !== foldIdentifier(table.name) ||
          table.columns.some((column) => column.key !== foldIdentifier(column.name)) ||
          Object.entries(table.options).some(
            ([key, value]) =>
              !["sqlite:STRICT", "sqlite:WITHOUT ROWID"].includes(key) || value !== true,
          ) ||
          table.columns.some(
            (column) => column.dataType !== null && typeof column.dataType !== "string",
          )
        ) {
          return yield* Effect.fail(
            new EncodeError({
              message:
                "Database model contains identity, type or option values unsupported by SQLite",
            }),
          );
        }
        // The shared model is extensible, so asserting a native AST is confined to this
        // adapter boundary. Encoding and reparsing validate it before returning any AST.
        const ast = {
          _tag: "CreateTable",
          name: table.name,
          schema: table.identity.catalog,
          temporary: false,
          ifNotExists: false,
          columns: table.columns.map((column) => ({
            name: column.name,
            typeName: column.dataType === null ? undefined : column.dataType,
            constraints: column.constraints.map(syntaxConstraint),
          })),
          tableConstraints: table.constraints.map(syntaxConstraint),
          ...(Object.keys(table.options).length
            ? {
                options: (["STRICT", "WITHOUT ROWID"] as const).filter(
                  (option) => table.options[`sqlite:${option}`],
                ),
              }
            : {}),
        } as unknown as CreateTable;
        const encoded = yield* createTable.encode(ast).pipe(
          Effect.catchDefect(() =>
            Effect.fail(
              new EncodeError({
                message: "Invalid SQLite constraint or expression in database model",
              }),
            ),
          ),
        );
        return yield* createTable
          .decode(encoded)
          .pipe(Effect.mapError((error) => new EncodeError({ message: error.message })));
      }),
    );
  });
