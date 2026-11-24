import { Effect } from "effect";

import { EncodeError } from "@uncutsql/codec";
import { SchemaDiffError, validateDatabase } from "@uncutsql/core";
import type { Constraint, DatabaseSchema, DiffDiagnostic } from "@uncutsql/core";

import { createIndex } from "./codecs/create-index.ts";
import type { CreateIndex } from "./codecs/create-index.ts";
import { createTable } from "./create-table.ts";
import type { CreateTable } from "./create-table.ts";
import { indexesFromDatabaseSchema, indexModel } from "./indexes.ts";
import { foldIdentifier, tableIdentity } from "./schema-identity.ts";
import { semanticValue, syntaxValue } from "./schema-value.ts";
import type { Statement } from "./schema.ts";
import { triggerModel, triggersFromDatabaseSchema } from "./triggers.ts";
import { viewsFromDatabaseSchema } from "./views.ts";

/** Structural semantic values, not source text or a parser AST. */
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
    const unsupported = statements.filter((statement) => statement._tag === "CreateTableAs");
    if (unsupported.length) {
      return yield* Effect.fail(
        new SchemaDiffError({
          diagnostics: unsupported.map((statement) => ({
            code: "UnsupportedSchemaStatement",
            message:
              "CREATE TABLE AS queries require SQLite evaluation to determine columns and populate data; use an explicit table definition for declarative schema comparison",
            side,
            table: {
              catalog: statement.schema ?? (statement.temporary ? "temp" : "main"),
              name: statement.name,
            },
          })),
        }),
      );
    }
    const tables = statements.filter((statement) => statement._tag === "CreateTable");
    const views = statements.filter((statement) => statement._tag === "CreateView");
    const indexGroups = new Map<string, CreateIndex[]>();
    const indexDiagnostics: DiffDiagnostic[] = [];
    const objectNames = new Set(tables.map((table) => JSON.stringify(tableIdentity(table))));
    for (const index of statements.filter((statement) => statement._tag === "CreateIndex")) {
      let candidates = tables.filter(
        (table) =>
          foldIdentifier(table.name) === foldIdentifier(index.table) &&
          (index.schema === undefined ||
            tableIdentity(table).schema === foldIdentifier(index.schema)),
      );
      if (index.schema === undefined) {
        const preferred =
          candidates.find((table) => tableIdentity(table).schema === "temp") ??
          candidates.find((table) => tableIdentity(table).schema === "main");
        if (preferred) {
          candidates = [preferred];
        }
      }
      if (candidates.length !== 1) {
        indexDiagnostics.push({
          code: "IndexTableResolution",
          message: `Index ${index.name} requires an unambiguous declared table; qualify the index schema if needed`,
          side,
          table: { catalog: index.schema ?? "main", name: index.table },
        });
        continue;
      }
      const table = candidates[0]!;
      const objectKey = JSON.stringify({
        name: foldIdentifier(index.name),
        schema: tableIdentity(table).schema,
      });
      if (objectNames.has(objectKey)) {
        indexDiagnostics.push({
          code: "DuplicateIndex",
          message: `Index ${index.name} conflicts with another table or index in its schema`,
          side,
          table: { catalog: tableIdentity(table).schema, name: table.name },
        });
      }
      objectNames.add(objectKey);
      const key = JSON.stringify(tableIdentity(table));
      indexGroups.set(key, [...(indexGroups.get(key) ?? []), index]);
      if (/^sqlite_/i.test(index.name)) {
        indexDiagnostics.push({
          code: "ReservedIndexName",
          message: "Standalone index names cannot use SQLite's reserved sqlite_ prefix",
          side,
          table: { catalog: tableIdentity(table).schema, name: table.name },
        });
      }
    }
    const relations: DatabaseSchema = {
      ...(views.length
        ? {
            views: views.map((view) => ({
              identity: { catalog: tableIdentity(view).schema, name: foldIdentifier(view.name) },
              name: view.name,
              ...(view.columns ? { columns: view.columns } : {}),
              query: semanticValue(view.query),
            })),
          }
        : {}),
      tables: tables.map((table) => {
        const identity = tableIdentity(table);
        return {
          identity: { catalog: identity.schema, name: identity.name },
          name: table.name,
          ...((indexGroups.get(JSON.stringify(identity))?.length ?? 0)
            ? {
                indexes: indexGroups
                  .get(JSON.stringify(identity))!
                  .map(indexModel)
                  .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
              }
            : {}),
          columns: table.columns.map((column) => ({
            constraints: column.constraints.map(constraint),
            dataType: column.typeName ?? null,
            key: foldIdentifier(column.name),
            name: column.name,
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
    const triggers = yield* Effect.forEach(
      statements.filter((s) => s._tag === "CreateTrigger"),
      (trigger) => triggerModel(trigger, relations),
    );
    const database = triggers.length ? { ...relations, triggers } : relations;
    const diagnostics = [...indexDiagnostics, ...validateDatabase(database, side)];
    for (const table of [...tables, ...views]) {
      const id = tableIdentity(table);
      if (table.temporary && id.schema !== "temp") {
        diagnostics.push({
          code: "InvalidTemporarySchema",
          message: `TEMP declaration ${JSON.stringify([id.schema, id.name])} must use the temp schema`,
          side,
          table: { catalog: id.schema, name: id.name },
        });
      }
    }
    if (diagnostics.length) {
      return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    }
    yield* Effect.forEach(tables, createTable.encode, { discard: true });
    yield* Effect.forEach(
      statements.filter((statement) => statement._tag === "CreateIndex"),
      createIndex.encode,
      { discard: true },
    );
    yield* viewsFromDatabaseSchema(database);
    yield* triggersFromDatabaseSchema(database);
    return database;
  });

const syntaxConstraint = (value: Constraint) => ({
  _tag: value.kind,
  ...Object.fromEntries(
    Object.entries(value.properties).map(([key, item]) => [key, syntaxValue(item)]),
  ),
});

/** Materialize SQLite-supported semantic models, including a JSON-restored baseline. */
export const tablesFromDatabaseSchema = (
  database: DatabaseSchema,
): Effect.Effect<readonly CreateTable[], SchemaDiffError | EncodeError> =>
  Effect.gen(function* () {
    const diagnostics = validateDatabase(database, "after");
    if (diagnostics.length) {
      return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    }
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
          columns: table.columns.map((column) => ({
            constraints: column.constraints.map(syntaxConstraint),
            name: column.name,
            typeName: column.dataType === null ? undefined : column.dataType,
          })),
          ifNotExists: false,
          name: table.name,
          schema: table.identity.catalog,
          tableConstraints: table.constraints.map(syntaxConstraint),
          temporary: false,
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

export const fromDatabaseSchema = (database: DatabaseSchema) =>
  Effect.gen(function* () {
    const tables = yield* tablesFromDatabaseSchema(database);
    const indexes = yield* indexesFromDatabaseSchema(database);
    return [
      ...tables,
      ...indexes,
      ...(yield* viewsFromDatabaseSchema(database)),
      ...(yield* triggersFromDatabaseSchema(database)),
    ];
  });
