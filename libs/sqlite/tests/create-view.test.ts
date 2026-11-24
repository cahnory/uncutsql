import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect } from "effect";
import { diffDatabases, planDatabaseMigration } from "@uncutsql/core";
import {
  lowerMigration,
  encodeMigration,
  createView,
  fromDatabaseSchema,
  schema,
  toDatabaseSchema,
} from "../src/index.ts";

test("view round trips retain native column names and results", () => {
  for (const sql of [
    "CREATE TEMP VIEW IF NOT EXISTS temp.v(x, y) AS VALUES (1, 2)",
    "CREATE VIEW main.v AS WITH data(n) AS (VALUES (2)) SELECT n COLLATE binary, n+1 FROM data",
  ]) {
    const ast = Effect.runSync(createView.decode(sql));
    const formatted = Effect.runSync(createView.encode(ast));
    assert.deepEqual(Effect.runSync(schema.decode(formatted)), [ast]);
    const inspect = (source: string) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(source);
        return db.prepare("SELECT * FROM v").all();
      } finally {
        db.close();
      }
    };
    assert.deepEqual(inspect(formatted), inspect(sql));
    const model = Effect.runSync(toDatabaseSchema([ast]));
    const restored = Effect.runSync(fromDatabaseSchema(JSON.parse(JSON.stringify(model))));
    assert.deepEqual(Effect.runSync(toDatabaseSchema(restored)), model);
  }
});

test("view declarations reject missing queries and empty result column lists", () => {
  for (const sql of [
    "CREATE VIEW v AS",
    "CREATE VIEW v() AS SELECT 1",
    "CREATE UNIQUE VIEW v AS SELECT 1",
  ])
    assert.throws(() => Effect.runSync(schema.decode(sql)));
});

test("rebuilds preserve chained views and refuse unmodeled triggers on a view", () => {
  const declarations =
    "; CREATE VIEW outer_v AS SELECT * FROM inner_v; CREATE VIEW inner_v AS SELECT n FROM t";
  const beforeSql = "CREATE TABLE t(n INT)" + declarations;
  const model = (sql: string) =>
    Effect.runSync(Effect.flatMap(schema.decode(sql), toDatabaseSchema));
  const before = model(beforeSql);
  const after = model("CREATE TABLE t(n INT UNIQUE)" + declarations);
  const diff = Effect.runSync(diffDatabases(before, after));
  const plan = Effect.runSync(lowerMigration(planDatabaseMigration(diff), before, after));
  const sql = Effect.runSync(encodeMigration(plan));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(beforeSql + "; INSERT INTO t VALUES (42)");
    db.exec("CREATE TRIGGER tr INSTEAD OF DELETE ON inner_v BEGIN SELECT 1; END");
    assert.throws(() => db.exec(sql), /CHECK/);
    db.exec("DROP TRIGGER tr");
    db.exec(sql);
    assert.equal(db.prepare("SELECT n FROM outer_v").get()?.n, 42);
  } finally {
    db.close();
  }
});

test("a partial logical plan rebuilds using the existing view definition", () => {
  const beforeSql = "CREATE TABLE t(n INT); CREATE VIEW v AS SELECT n FROM t";
  const afterSql =
    "CREATE TABLE t(n INT UNIQUE); CREATE VIEW v AS SELECT 99 AS n; CREATE VIEW later_view AS VALUES (1)";
  const model = (sql: string) =>
    Effect.runSync(Effect.flatMap(schema.decode(sql), toDatabaseSchema));
  const before = model(beforeSql);
  const after = model(afterSql);
  const all = planDatabaseMigration(Effect.runSync(diffDatabases(before, after)));
  const plan = Effect.runSync(
    lowerMigration(
      { procedures: all.procedures.filter((p) => p._tag === "AlterTable") },
      before,
      after,
    ),
  );
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(beforeSql + "; INSERT INTO t VALUES (7)");
    db.exec(Effect.runSync(encodeMigration(plan)));
    assert.equal(db.prepare("SELECT n FROM v").get()?.n, 7);
  } finally {
    db.close();
  }
});
