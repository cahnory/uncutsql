import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { diffDatabases, planDatabaseMigration } from "@uncutsql/core";
import {
  schema,
  toDatabaseSchema,
  fromDatabaseSchema,
  planMigrationFromDatabase,
  encodeMigration,
} from "../src/index.ts";

const convert = (sql: string) =>
  Effect.runSync(Effect.flatMap(schema.decode(sql), toDatabaseSchema));

test("SQLite adapter resolves identity and options before handing the model to core", () => {
  const database = convert(
    "CREATE TEMP TABLE T (ID INTEGER PRIMARY KEY, x TEXT DEFAULT (abs(-1))) STRICT",
  );
  const table = database.tables[0]!;
  assert.deepEqual(table.identity, { catalog: "temp", name: "t" });
  assert.deepEqual(table.options, { "sqlite:STRICT": true });
  assert.equal(table.columns[0]!.key, "id");
  assert.equal(table.columns[0]!.name, "ID");
  assert.equal(table.columns[1]!.constraints[0]!.kind, "Default");
  assert.equal(JSON.stringify(database).includes('"_tag"'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(database)), database);
});

test("SQLite models can use the standalone core diff and logical procedure planner", () => {
  const before = convert("CREATE TABLE t (a INTEGER)");
  const after = convert("CREATE TABLE t (a TEXT, b)");
  const diff = Effect.runSync(diffDatabases(before, after));
  const procedures = planDatabaseMigration(diff).procedures;
  assert.equal(procedures[0]!._tag, "AlterTable");
  if (procedures[0]!._tag === "AlterTable")
    assert.deepEqual(
      procedures[0]!.changes.map((item) => item._tag),
      ["ColumnChanged", "ColumnAdded"],
    );
});

test("serialized shared models round-trip through the SQLite adapter", () => {
  const model = convert(`CREATE TEMP TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT,
    a TEXT DEFAULT (lower('ABC')), b INTEGER AS (length(a)) STORED, UNIQUE(a)) STRICT`);
  const restored = JSON.parse(JSON.stringify(model));
  const ast = Effect.runSync(fromDatabaseSchema(restored));
  assert.deepEqual(Effect.runSync(toDatabaseSchema(ast)), model);
});

test("SQLite renders and executes a migration using only JSON-restored shared models", () => {
  const beforeSql = "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)";
  const before = JSON.parse(JSON.stringify(convert(beforeSql)));
  const after = JSON.parse(
    JSON.stringify(convert("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)")),
  );
  const plan = Effect.runSync(planMigrationFromDatabase(before, after));
  const sql = Effect.runSync(encodeMigration(plan));
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(beforeSql);
    database.exec("INSERT INTO t VALUES (7, 'retained')");
    database.exec(sql);
    assert.deepEqual({ ...database.prepare("SELECT * FROM t").get() }, { id: 7, name: "retained" });
    assert.throws(() => database.exec("INSERT INTO t VALUES (8, 'retained')"), /UNIQUE/);
  } finally {
    database.close();
  }
});

test("SQLite refuses unsupported model extensions instead of dropping their semantics", () => {
  const model = convert("CREATE TABLE t (id)");
  for (const table of [
    { ...model.tables[0]!, options: { "other:partition": "hash" } },
    { ...model.tables[0]!, identity: { catalog: "app", schema: "public", name: "t" } },
    {
      ...model.tables[0]!,
      columns: [{ ...model.tables[0]!.columns[0]!, dataType: { name: "domain" } }],
    },
    { ...model.tables[0]!, constraints: [{ kind: "Unsupported", properties: {} }] },
  ]) {
    assert.ok(
      Result.isFailure(Effect.runSync(Effect.result(fromDatabaseSchema({ tables: [table] })))),
    );
  }
});
