import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Data, Effect } from "effect";

import { decodeDatabaseSchema } from "@uncutsql/core";
import type {
  DatabaseSchema,
  ExecutionResult,
  MigrationCheckpoint,
  MigrationExecutor,
  MigrationSource,
} from "@uncutsql/core";
import { schema, toDatabaseSchema } from "@uncutsql/sqlite";

import { compactSqlite } from "./compact.ts";
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

const schemaObjects = (database: DatabaseSync) =>
  native("Inspect schema", () =>
    database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND NOT (type = 'table' AND name = ? COLLATE NOCASE) ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name",
      )
      .all(historyName),
  );

const inspectDatabase = (database: DatabaseSync) =>
  Effect.gen(function* () {
    const objects = yield* schemaObjects(database);
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

const readHistory = (database: DatabaseSync, down: boolean, initialize = true) =>
  Effect.gen(function* () {
    const object = yield* native("Inspect applied history", () =>
      database
        .prepare("SELECT type FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE")
        .get(historyName),
    );
    const empty: DatabaseSchema = { tables: [] };
    if (!object && !initialize) {
      return { lastId: 0, previous: empty, sha256: null, snapshot: empty };
    }
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
          `SELECT id, sha256, dialect, format_version, database_json FROM ${historyTable} ORDER BY id DESC LIMIT ${down ? 2 : 1}`,
        )
        .all()
        .reverse(),
    );
    if (
      rows.some(
        (row, index) =>
          typeof row.id !== "number" ||
          !Number.isSafeInteger(row.id) ||
          row.id < 1 ||
          (down && index === 0 && rows.length === 1 && row.id !== 1) ||
          (index > 0 && rows[index - 1]?.id !== row.id - 1) ||
          typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.sha256) ||
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
    let snapshot = empty;
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
    const tip = rows.at(-1);
    return {
      lastId: Number(tip?.id ?? 0),
      previous,
      sha256: tip ? String(tip.sha256) : null,
      snapshot,
    };
  });

const checkpoint: MigrationExecutor<SqliteExecutionError>["checkpoint"] = (target) =>
  Effect.gen(function* () {
    const exists = yield* native(
      "Inspect database file",
      () => statSync(target, { throwIfNoEntry: false }) !== undefined,
    );
    if (!exists) {
      return { id: 0, sha256: null };
    }
    return yield* Effect.acquireUseRelease(
      native(
        "Open SQLite checkpoint",
        () => new DatabaseSync(target, { readOnly: true, timeout: 5000 }),
      ),
      (database) =>
        readHistory(database, false, false).pipe(
          Effect.map((history) => ({ id: history.lastId, sha256: history.sha256 })),
        ),
      (database) => native("Close SQLite checkpoint", () => database.close()),
    );
  });

const recordMigration = (
  database: DatabaseSync,
  migration: MigrationSource,
  snapshot: DatabaseSchema,
) => {
  database
    .prepare(
      `INSERT INTO ${historyTable} (id, sha256, dialect, format_version, database_json, applied_at) VALUES (?, ?, 'sqlite', 1, ?, ?)`,
    )
    .run(
      migration.id,
      migration.baselineCheckpoint ?? migration.sha256,
      JSON.stringify(snapshot),
      new Date().toISOString(),
    );
};

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
  start?: MigrationCheckpoint,
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
    const down = direction === "down";
    const baseline = migrations[0]?.baselineCheckpoint !== undefined ? migrations[0] : undefined;
    const checkpointId = start?.id ?? 0;
    const firstUpId = baseline?.id ?? checkpointId + 1;
    const offset = down ? Math.max(0, checkpointId - 1) : firstUpId - 1;
    const lastId = offset + migrations.length;
    if (
      (baseline &&
        (down ||
          (start?.id ?? 0) !== 0 ||
          !Number.isSafeInteger(baseline.id) ||
          baseline.id < 2 ||
          !/^[a-f0-9]{64}$/.test(baseline.baselineCheckpoint!))) ||
      (down &&
        start &&
        (migrations.length !== (start.id ? 1 : 0) ||
          (start.id > 0 && migrations[0]?.sha256 !== start.sha256))) ||
      migrations.some(
        (migration, index) =>
          (index > 0 && migration.baselineCheckpoint !== undefined) ||
          migration.id !== offset + index + 1 ||
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
                  const history = yield* readHistory(database, down);
                  const applied = migrations[history.lastId - offset - 1];
                  const expected =
                    start && history.lastId === start.id
                      ? start.sha256
                      : history.lastId === 0
                        ? null
                        : (applied?.baselineCheckpoint ?? applied?.sha256);
                  if (
                    expected !== history.sha256 ||
                    history.lastId < (start?.id ?? 0) ||
                    (down && start && history.lastId !== start.id)
                  ) {
                    return yield* Effect.fail(
                      new SqliteExecutionError({
                        message:
                          "Database checkpoint is not a matching prefix of the supplied migrations",
                      }),
                    );
                  }
                  const actual = yield* inspectDatabase(database);
                  if (history.lastId === 0 && (actual.tables.length || actual.views?.length)) {
                    return yield* Effect.fail(
                      new SqliteExecutionError({
                        message:
                          "Refusing to adopt a nonempty database without applied migration history. Use adopt <database> <migration-number> to verify and initialize its history.",
                      }),
                    );
                  }
                  yield* verifySchema(actual, history.snapshot, "applied");
                  const next =
                    baseline && history.lastId === 0
                      ? baseline
                      : migrations[history.lastId - offset - (down ? 1 : 0)];
                  if (!next) {
                    if (!down) {
                      yield* verifySchema(actual, desired, "desired");
                    }
                    yield* native("Commit history verification", () => database.exec("COMMIT"));
                    return { done: true, id: history.lastId };
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
                  if (next.id === lastId) {
                    yield* verifySchema(updated, desired, "desired");
                  }
                  yield* native("Record applied migration", () => {
                    recordMigration(database, next, updated);
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

const extract: NonNullable<MigrationExecutor<SqliteExecutionError>["extract"]> = (target) =>
  Effect.acquireUseRelease(
    native("Open existing SQLite database", () => new DatabaseSync(target, { readOnly: true })),
    (db) =>
      Effect.gen(function* () {
        yield* native("Begin schema inspection", () => db.exec("BEGIN"));
        yield* readHistory(db, false, false);
        yield* inspectDatabase(db);
        const groups = new Map<string, { name: string; statements: string[] }>();
        for (const object of yield* schemaObjects(db)) {
          const owner = String(object.tbl_name);
          const key = owner.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
          const group = groups.get(key) ?? { name: owner, statements: [] };
          group.statements.push(String(object.sql) + ";\n");
          groups.set(key, group);
        }
        return Array.from(groups.values(), ({ name, statements }) => ({
          name,
          sql: statements.join(""),
        }));
      }),
    (db) => native("Close SQLite database", () => db.close()),
  );

const adopt: NonNullable<MigrationExecutor<SqliteExecutionError>["adopt"]> = (
  target,
  prefix,
  verify,
  desired,
) =>
  Effect.acquireUseRelease(
    native("Open migration replay", () => new DatabaseSync(":memory:")),
    (scratch) =>
      Effect.gen(function* () {
        const snapshots: { migration: MigrationSource; schema: DatabaseSchema }[] = [];
        for (const migration of prefix) {
          yield* native(`Replay migration ${migration.id}`, () => {
            const previous = snapshots.at(-1);
            const validPosition =
              migration.baselineCheckpoint !== undefined
                ? !previous &&
                  Number.isSafeInteger(migration.id) &&
                  migration.id >= 2 &&
                  /^[a-f0-9]{64}$/.test(migration.baselineCheckpoint)
                : migration.id === (previous?.migration.id ?? 0) + 1;
            if (
              !validPosition ||
              migration.sql.includes("\0") ||
              digest(migration.sql) !== migration.sha256
            ) {
              throw new Error("Invalid migration ID, SQL or checksum");
            }
            scratch.exec("PRAGMA foreign_keys=OFF; BEGIN");
            executeScriptBody(scratch, migration.sql, historyName);
            if (scratch.prepare("PRAGMA foreign_key_check").get()) {
              throw new Error("Foreign-key violation in replayed migration");
            }
            scratch.exec("COMMIT");
          });
          snapshots.push({ migration, schema: yield* inspectDatabase(scratch) });
        }
        const tip = snapshots.at(-1);
        if (!tip) {
          return yield* Effect.fail(
            new SqliteExecutionError({ message: "Expected a migration prefix" }),
          );
        }
        if (desired) {
          yield* verify(tip.schema, desired);
        }
        yield* Effect.acquireUseRelease(
          native("Open existing SQLite database", () => {
            if (!statSync(target).isFile()) {
              throw new Error("Expected an existing database file");
            }
            return new DatabaseSync(target, { timeout: 5000 });
          }),
          (db) =>
            Effect.gen(function* () {
              yield* native("Begin adoption", () => {
                db.exec("BEGIN IMMEDIATE");
                if (
                  db
                    .prepare("SELECT 1 FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE")
                    .get(historyName)
                ) {
                  throw new Error(
                    "Database already contains migration history or a reserved object",
                  );
                }
              });
              yield* verify(yield* inspectDatabase(db), tip.schema);
              yield* native("Initialize migration history", () => {
                db.exec(historyDdl);
                for (const { migration, schema } of snapshots) {
                  recordMigration(db, migration, schema);
                }
                db.exec("COMMIT");
              });
            }),
          (db) => native("Close SQLite database", () => db.close()),
        );
      }),
    (scratch) => native("Close migration replay", () => scratch.close()),
  );

export const executor: MigrationExecutor<SqliteExecutionError> = {
  adopt,
  apply: applyMigrations,
  checkpoint,
  compact: (migrations) =>
    native("Compact SQLite migrations", () => compactSqlite(migrations, historyName)),
  dialect: "sqlite",
  extract,
  rollback: rollbackMigration,
};
