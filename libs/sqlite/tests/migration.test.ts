import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import {
  schema,
  diffSchemas,
  planMigration,
  encodeMigration,
  MigrationPlanError,
  type MigrationPlan,
} from "../src/index.ts";

const parse = (sql: string) => Effect.runSync(schema.decode(sql));
const plan = (before: string, after: string) =>
  Effect.runSync(planMigration(parse(before), parse(after)));
const sql = (before: string, after: string) => Effect.runSync(encodeMigration(plan(before, after)));
const currentSchema = (database: DatabaseSync) =>
  parse(
    database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.sql)
      .join(";\n"),
  );

test("migration creates tables with explicit placement and removes creation guards", () => {
  const after =
    "CREATE TABLE IF NOT EXISTS child (id INTEGER PRIMARY KEY, parent_id REFERENCES parent(id)); CREATE TABLE parent (id INTEGER PRIMARY KEY)";
  const migration = sql("", after);
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /CREATE TABLE "main"\."child"/);
  assert.doesNotMatch(migration, /IF NOT EXISTS/);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.exec(migration);
    database.exec("INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1, 1)");
    assert.deepEqual(Effect.runSync(diffSchemas(currentSchema(database), parse(after))), {
      changes: [],
    });
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("appended columns preserve populated rows and produce the desired schema", () => {
  const before = "CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)";
  const after =
    "CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT, note TEXT DEFAULT 'hello', count INTEGER NOT NULL DEFAULT -1, payload BLOB DEFAULT X'CAFE', optional TEXT COLLATE NOCASE)";
  const migration = sql(before, after);
  assert.match(migration, /ALTER TABLE "main"\."t" ADD COLUMN/);
  assert.doesNotMatch(migration, /DROP TABLE/);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(before);
    database.exec("INSERT INTO t VALUES (1, 'kept'), (2, 'also kept')");
    database.exec(migration);
    const rows = database
      .prepare(
        "SELECT id, value, note, count, hex(payload) AS payload, optional FROM t ORDER BY id",
      )
      .all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { id: 1, value: "kept", note: "hello", count: -1, payload: "CAFE", optional: null },
        { id: 2, value: "also kept", note: "hello", count: -1, payload: "CAFE", optional: null },
      ],
    );
    assert.deepEqual(Effect.runSync(diffSchemas(currentSchema(database), parse(after))), {
      changes: [],
    });
  } finally {
    database.close();
  }
});

test("dropped child tables precede parents with enforced foreign keys and data", () => {
  const before =
    "CREATE TABLE parent (id PRIMARY KEY); CREATE TABLE child (id, parent_id REFERENCES parent(id) ON DELETE RESTRICT)";
  const planned = plan(before, "");
  assert.deepEqual(
    planned.operations.map((operation) =>
      operation._tag === "DropTable" ? operation.table.name : "",
    ),
    ["child", "parent"],
  );
  assert.equal(planned.warnings.length, 2);
  const migration = Effect.runSync(encodeMigration(planned));
  assert.match(migration, /WARNING: Dropping table/);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.exec(before);
    database.exec("INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1, 1)");
    database.exec(migration);
    assert.deepEqual(currentSchema(database), []);
    assert.equal(database.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  } finally {
    database.close();
  }
});

test("qualified migration targets avoid temp shadowing and escape identifiers", () => {
  const before = 'CREATE TABLE "a.b" (id); CREATE TEMP TABLE "a.b" (id)';
  const after =
    'CREATE TABLE "a.b" (id, "new\\name" TEXT DEFAULT \'a;b\'); CREATE TEMP TABLE "a.b" (id)';
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(before);
    database.exec(sql(before, after));
    assert.equal(database.prepare('PRAGMA main.table_info("a.b")').all().length, 2);
    assert.equal(database.prepare('PRAGMA temp.table_info("a.b")').all().length, 1);
    database.exec(sql(after, 'CREATE TEMP TABLE "a.b" (id)'));
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE type='table'").get()!.n,
      1,
    );
  } finally {
    database.close();
  }
});

test("temporary and attached schema tables can be created explicitly", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("ATTACH ':memory:' AS aux");
    database.exec(sql("", "CREATE TEMP TABLE t (id); CREATE TABLE aux.t (id)"));
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE type='table'").get()!.n,
      1,
    );
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM aux.sqlite_schema WHERE type='table'").get()!.n,
      1,
    );
  } finally {
    database.close();
  }
});

for (const [name, after] of [
  ["column editing", "CREATE TABLE t (a TEXT)"],
  ["column removal", "CREATE TABLE t (b)"],
  ["column insertion", "CREATE TABLE t (b, a INTEGER)"],
  ["constraints", "CREATE TABLE t (a INTEGER, CHECK(a > 0))"],
  ["options", "CREATE TABLE t (a INTEGER) STRICT"],
]) {
  test(`migration rejects rebuild-dependent ${name}`, () => {
    const result = Effect.runSync(
      Effect.result(planMigration(parse("CREATE TABLE t (a INTEGER)"), parse(after!))),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof MigrationPlanError);
    assert.equal(result.failure.diagnostics[0]!.code, "TableRebuildRequired");
  });
}

for (const column of [
  "b UNIQUE",
  "b PRIMARY KEY",
  "b NOT NULL",
  "b NOT NULL DEFAULT NULL",
  "b DEFAULT CURRENT_TIMESTAMP",
  "b DEFAULT (1 + 2)",
  "b DEFAULT (abs(1))",
  "b GENERATED ALWAYS AS (a + 1) VIRTUAL",
  "b REFERENCES parent(id)",
  "b CHECK (b > 0)",
  "b DEFAULT 1 DEFAULT 2",
]) {
  test(`migration rejects unsupported appended column: ${column}`, () => {
    const result = Effect.runSync(
      Effect.result(
        planMigration(parse("CREATE TABLE t (a)"), parse(`CREATE TABLE t (a, ${column})`)),
      ),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof MigrationPlanError);
    assert.equal(result.failure.diagnostics[0]!.code, "UnsupportedAddColumn");
  });
}

test("migration rejects retained references to removed parents and cyclic drops", () => {
  for (const [before, after, code] of [
    [
      "CREATE TABLE p (id PRIMARY KEY); CREATE TABLE c (x REFERENCES p(id))",
      "CREATE TABLE c (x REFERENCES p(id))",
      "RetainedForeignKey",
    ],
    [
      "CREATE TABLE a (x REFERENCES b(x)); CREATE TABLE b (x REFERENCES a(x))",
      "",
      "ForeignKeyCycle",
    ],
    ["CREATE TABLE a (x REFERENCES a(x))", "", "ForeignKeyCycle"],
  ]) {
    const result = Effect.runSync(Effect.result(planMigration(parse(before!), parse(after!))));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof MigrationPlanError);
    assert.equal(result.failure.diagnostics[0]!.code, code);
  }
});

test("no-op migrations are empty and unknown operations fail encoding", () => {
  assert.equal(sql("CREATE TABLE t (a)", "CREATE TABLE t (a)"), "");
  const invalid = { operations: [{ _tag: "Unknown" }], warnings: [] } as unknown as MigrationPlan;
  assert.ok(Result.isFailure(Effect.runSync(Effect.result(encodeMigration(invalid)))));
});
