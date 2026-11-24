import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect } from "effect";
import {
  prepareMigrationDecisions,
  resolveMigrationDecisions,
  planDatabaseMigration,
} from "@uncutsql/core";
import { schema, toDatabaseSchema, lowerMigration, encodeMigration } from "../src/index.ts";
const model = (sql: string) => Effect.runSync(toDatabaseSchema(Effect.runSync(schema.decode(sql))));
const plan = (beforeSql: string, afterSql: string, rename: boolean) => {
  const before = model(beforeSql),
    after = model(afterSql);
  const doc = Effect.runSync(prepareMigrationDecisions(before, after));
  const resolved = Effect.runSync(
    resolveMigrationDecisions(before, after, {
      ...doc,
      decisions: doc.decisions.map((item) => ({
        ...item,
        resolution: rename ? { action: "rename", target: "new" } : { action: "drop" },
      })),
    }),
  );
  return Effect.runSync(lowerMigration(planDatabaseMigration(resolved.diff), before, after));
};
test("confirmed renames preserve data alongside type and constraint changes", () => {
  for (const suffix of ["", " WITHOUT ROWID"]) {
    const before = `CREATE TABLE t(old INTEGER PRIMARY KEY, value TEXT)${suffix}`;
    const after = `CREATE TABLE t(new TEXT PRIMARY KEY NOT NULL, value TEXT)${suffix}`;
    const migration = plan(before, after, true);
    assert.equal(migration.warnings.length, 0);
    const sql = Effect.runSync(encodeMigration(migration));
    assert.match(sql, /"new"/);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(before + "; INSERT INTO t VALUES(42,'kept')");
      db.exec(sql);
      assert.deepEqual({ ...db.prepare("SELECT * FROM t").get() }, { new: "42", value: "kept" });
    } finally {
      db.close();
    }
  }
});
test("explicit drop/add uses defaults rather than copying the removed column", () => {
  const before = "CREATE TABLE t(id INTEGER PRIMARY KEY, old TEXT)",
    after = "CREATE TABLE t(id INTEGER PRIMARY KEY, new TEXT DEFAULT 'fresh')";
  const migration = plan(before, after, false);
  assert.equal(migration.warnings[0]!.code, "ColumnDataLoss");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(before + "; INSERT INTO t VALUES(1,'old data')");
    db.exec(Effect.runSync(encodeMigration(migration)));
    assert.equal(db.prepare("SELECT new FROM t").get()!.new, "fresh");
  } finally {
    db.close();
  }
});
test("incompatible renamed data rolls back instead of losing the old column", () => {
  const before = "CREATE TABLE t(old TEXT)",
    after = "CREATE TABLE t(new TEXT NOT NULL)";
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(before + "; INSERT INTO t VALUES(NULL)");
    assert.throws(
      () => db.exec(Effect.runSync(encodeMigration(plan(before, after, true)))),
      /NOT NULL/,
    );
    assert.equal(db.prepare("SELECT old FROM t").get()!.old, null);
  } finally {
    db.close();
  }
});

test("renaming an AUTOINCREMENT key retains rowids and its deleted-row high-water mark", () => {
  const before = "CREATE TABLE t(old INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)";
  const after = "CREATE TABLE t(new INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)";
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      before + "; INSERT INTO t VALUES(5,'kept'),(100,'deleted'); DELETE FROM t WHERE old=100",
    );
    db.exec(Effect.runSync(encodeMigration(plan(before, after, true))));
    db.exec("INSERT INTO t(value) VALUES('next')");
    assert.deepEqual(
      db
        .prepare("SELECT new FROM t ORDER BY new")
        .all()
        .map((row) => row.new),
      [5, 101],
    );
  } finally {
    db.close();
  }
});
