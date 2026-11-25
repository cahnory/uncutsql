import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { Data, Effect } from "effect";

import { decodeDatabaseSchema } from "@uncutsql/core";
import type {
  DatabaseSchema,
  ExecutionResult,
  MigrationExecutor,
  MigrationSource,
} from "@uncutsql/core";
import { schema, toDatabaseSchema } from "@uncutsql/sqlite";

import { executeScriptBody } from "./script.ts";

export class SqliteExecutionError extends Data.TaggedError("SqliteExecutionError")<{
  readonly appliedIds?: readonly number[];
  readonly message: string;
  readonly migrationId?: number;
}> {}
const historyName = "__uncutsql_migrations";
const historyTable = `main."${historyName}"`;
const historyDdl = `CREATE TABLE ${historyTable} (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, dialect TEXT NOT NULL, format_version INTEGER NOT NULL, database_json TEXT NOT NULL, applied_at TEXT NOT NULL)`;
const native = <A>(label: string, operation: () => A) =>
  Effect.try({
    catch: (cause) =>
      new SqliteExecutionError({
        message: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    try: operation,
  });
const digest = (sql: string) => createHash("sha256").update(sql, "utf8").digest("hex");

const inspectDatabase = (database: DatabaseSync) =>
  Effect.gen(function* () {
    const objects = yield* native("Inspect schema", () =>
      database
        .prepare(
          "SELECT type, name, sql FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND NOT (type = 'table' AND name = ? COLLATE NOCASE) ORDER BY name",
        )
        .all(historyName),
    );
    const unsupported = objects.find(
      (object) =>
        object.type !== "table" &&
        object.type !== "index" &&
        object.type !== "view" &&
        object.type !== "trigger",
    );
    if (unsupported) {
      return yield* Effect.fail(
        new SqliteExecutionError({
          message: `Unsupported live schema object ${String(unsupported.type)} ${JSON.stringify(unsupported.name)}`,
        }),
      );
    }
    const temporary = yield* native("Inspect temporary schema", () =>
      database.prepare("SELECT name FROM temp.sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all(),
    );
    if (temporary.length) {
      return yield* Effect.fail(
        new SqliteExecutionError({ message: "Migration left temporary schema objects behind" }),
      );
    }
    const sql = objects.map((object) => String(object.sql)).join(";\n");
    const ast = yield* schema.decode(sql).pipe(
      Effect.mapError(
        (error) =>
          new SqliteExecutionError({
            message: `Unsupported live schema syntax: ${error.message}`,
          }),
      ),
    );
    return yield* toDatabaseSchema(ast).pipe(
      Effect.mapError((error) => new SqliteExecutionError({ message: error.message })),
    );
  });

const readHistory = (database: DatabaseSync, migrations: readonly MigrationSource[]) =>
  Effect.gen(function* () {
    const object = yield* native("Inspect applied history", () =>
      database
        .prepare("SELECT type FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE")
        .get(historyName),
    );
    if (!object) {
      yield* native("Initialize applied history", () => database.exec(historyDdl));
    } else if (object.type !== "table") {
      return yield* Effect.fail(
        new SqliteExecutionError({ message: "The reserved applied-history name is not a table" }),
      );
    }
    const columns = yield* native("Validate applied-history table", () =>
      database.prepare(`PRAGMA main.table_xinfo("${historyName}")`).all(),
    );
    const names = ["id", "sha256", "dialect", "format_version", "database_json", "applied_at"];
    if (
      columns.length !== names.length ||
      columns.some(
        (column, index) =>
          column.name !== names[index] ||
          column.pk !== (index === 0 ? 1 : 0) ||
          column.notnull !== (index === 0 ? 0 : 1) ||
          column.hidden !== 0 ||
          column.dflt_value !== null ||
          column.type !== (index === 0 || index === 3 ? "INTEGER" : "TEXT"),
      )
    ) {
      return yield* Effect.fail(
        new SqliteExecutionError({ message: "Unrecognized applied-history table format" }),
      );
    }
    const rows = yield* native("Read applied history", () =>
      database
        .prepare(
          `SELECT id, sha256, dialect, format_version, database_json FROM ${historyTable} ORDER BY id`,
        )
        .all(),
    );
    if (
      rows.length > migrations.length ||
      rows.some(
        (row, index) =>
          row.id !== index + 1 ||
          row.sha256 !== migrations[index]?.sha256 ||
          row.dialect !== "sqlite" ||
          row.format_version !== 1,
      )
    ) {
      return yield* Effect.fail(
        new SqliteExecutionError({
          message:
            "Applied migration history is not a matching prefix of the supplied files (ID, checksum, dialect or version mismatch)",
        }),
      );
    }
    let snapshot: DatabaseSchema = { tables: [] };
    let previous = snapshot;
    for (const row of rows) {
      const value: unknown = yield* native("Decode applied schema snapshot", () => {
        if (typeof row.database_json !== "string") {
          throw new Error("Expected snapshot JSON");
        }
        return JSON.parse(row.database_json);
      });
      const decoded = yield* decodeDatabaseSchema(value).pipe(
        Effect.mapError((error) => new SqliteExecutionError({ message: error.message })),
      );
      previous = snapshot;
      snapshot = decoded;
    }
    return { count: rows.length, previous, snapshot };
  });

const runMigrations = <V extends Error, RV>(
  direction: "up" | "down",
  target: string,
  migrations: readonly MigrationSource[],
  desired: DatabaseSchema,
  verifySchema: (
    actual: DatabaseSchema,
    expected: DatabaseSchema,
    stage: "applied" | "desired",
  ) => Effect.Effect<void, V, RV>,
): Effect.Effect<ExecutionResult, SqliteExecutionError | V, RV> =>
  Effect.gen(function* () {
    if (
      target === ":memory:" ||
      [...desired.tables, ...(desired.views ?? []), ...(desired.triggers ?? [])].some(
        (table) =>
          table.identity.catalog !== "main" ||
          table.identity.schema !== undefined ||
          table.identity.name === historyName,
      )
    ) {
      return yield* Effect.fail(
        new SqliteExecutionError({
          message:
            "This executor requires a file-backed main database and reserves __uncutsql_migrations",
        }),
      );
    }
    if (
      migrations.some(
        (migration, index) =>
          migration.id !== index + 1 ||
          !migration.sql.trim() ||
          migration.sql.includes("\0") ||
          digest(migration.sql) !== migration.sha256,
      )
    ) {
      return yield* Effect.fail(
        new SqliteExecutionError({ message: "Invalid migration IDs, SQL or checksums" }),
      );
    }
    const appliedIds: number[] = [];
    let currentId: number | undefined;
    return yield* Effect.acquireUseRelease(
      native("Open SQLite database", () => {
        const database = new DatabaseSync(target, {
          enableForeignKeyConstraints: true,
          timeout: 5000,
        });
        if (!database.location("main")) {
          database.close();
          throw new Error("A persistent database file is required");
        }
        return database;
      }),
      (database) =>
        Effect.gen(function* () {
          while (true) {
            currentId = undefined;
            const result = yield* Effect.acquireUseRelease(
              native("Begin migration transaction", () => {
                database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
              }),
              () =>
                Effect.gen(function* () {
                  const history = yield* readHistory(database, migrations);
                  const actual = yield* inspectDatabase(database);
                  if (history.count === 0 && (actual.tables.length || actual.views?.length)) {
                    return yield* Effect.fail(
                      new SqliteExecutionError({
                        message:
                          "Refusing to adopt a nonempty database without applied migration history",
                      }),
                    );
                  }
                  yield* verifySchema(actual, history.snapshot, "applied");
                  const down = direction === "down";
                  const next = migrations[down ? history.count - 1 : history.count];
                  if (!next) {
                    if (!down) {
                      yield* verifySchema(actual, desired, "desired");
                    }
                    yield* native("Commit history verification", () => database.exec("COMMIT"));
                    return { done: true, id: history.count };
                  }
                  currentId = next.id;
                  let sql = next.sql;
                  if (down) {
                    if (!next.down || !("sql" in next.down)) {
                      return yield* Effect.fail(
                        new SqliteExecutionError({
                          message: `Cannot roll back migration ${next.id}. ${next.down?.reason ?? "No down SQL is available."}`,
                        }),
                      );
                    }
                    sql = next.down.sql;
                  }
                  yield* native(`Execute migration ${next.id}`, () =>
                    executeScriptBody(database, sql, historyName),
                  );
                  const violations = yield* native("Check foreign keys", () =>
                    database.prepare("PRAGMA main.foreign_key_check").all(),
                  );
                  if (violations.length) {
                    return yield* Effect.fail(
                      new SqliteExecutionError({
                        message: "Migration produced foreign-key violations",
                      }),
                    );
                  }
                  const updated = yield* inspectDatabase(database);
                  if (down) {
                    yield* verifySchema(updated, history.previous, "applied");
                    yield* native("Record rolled back migration", () => {
                      database.prepare(`DELETE FROM ${historyTable} WHERE id = ?`).run(next.id);
                      database.exec("COMMIT");
                    });
                    return { done: true, id: next.id - 1, rolledBackId: next.id };
                  }
                  if (next.id === migrations.length) {
                    yield* verifySchema(updated, desired, "desired");
                  }
                  yield* native("Record applied migration", () => {
                    database
                      .prepare(
                        `INSERT INTO ${historyTable} (id, sha256, dialect, format_version, database_json, applied_at) VALUES (?, ?, 'sqlite', 1, ?, ?)`,
                      )
                      .run(next.id, next.sha256, JSON.stringify(updated), new Date().toISOString());
                    database.exec("COMMIT");
                  });
                  appliedIds.push(next.id);
                  return { done: false, id: next.id };
                }),
              () =>
                native("Clean up migration transaction", () => {
                  database.setAuthorizer(null);
                  if (database.isTransaction) {
                    database.exec("ROLLBACK");
                  }
                  database.exec("PRAGMA foreign_keys=ON");
                }),
            );
            if (result.done) {
              return {
                appliedIds,
                lastAppliedId: result.id,
                ...(result.rolledBackId === undefined ? {} : { rolledBackId: result.rolledBackId }),
              };
            }
          }
        }),
      (database) => native("Close SQLite database", () => database.close()),
    ).pipe(
      Effect.mapError(
        (error) =>
          new SqliteExecutionError({
            message: `${error.message}${appliedIds.length ? `; migrations ${appliedIds.join(", ")} were committed before this failure` : ""}`,
            ...(currentId === undefined ? {} : { migrationId: currentId }),
            appliedIds: [...appliedIds],
          }),
      ),
    );
  });

export const applyMigrations: MigrationExecutor<SqliteExecutionError>["apply"] = (...args) =>
  runMigrations("up", ...args);

export const rollbackMigration: MigrationExecutor<SqliteExecutionError>["apply"] = (...args) =>
  runMigrations("down", ...args);

export const executor: MigrationExecutor<SqliteExecutionError> = {
  apply: applyMigrations,
  dialect: "sqlite",
  rollback: rollbackMigration,
};
