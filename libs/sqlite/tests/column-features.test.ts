import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect } from "effect";

import { createTable } from "../src/index.ts";

const versions = (source: string) => {
  const ast = Effect.runSync(createTable.decode(source));
  const encoded = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(encoded)), ast);
  return [source, encoded];
};

test("AUTOINCREMENT preserves sequence behavior after deleting the highest row", () => {
  const source =
    "CREATE TABLE t (id INTEGER PRIMARY KEY ASC ON CONFLICT REPLACE AUTOINCREMENT, name TEXT)";
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec(
        "INSERT INTO t(name) VALUES ('first'); DELETE FROM t; INSERT INTO t(name) VALUES ('second')",
      );
      assert.equal(database.prepare("SELECT id FROM t").get()!.id, 2);
      database.exec("INSERT INTO t VALUES (2,'replacement')");
      assert.deepEqual(
        { ...database.prepare("SELECT * FROM t").get()! },
        { id: 2, name: "replacement" },
      );
    } finally {
      database.close();
    }
  }
});

test("descending INTEGER PRIMARY KEY retains SQLite's non-rowid-alias behavior", () => {
  for (const order of ["ASC", "DESC"]) {
    for (const sql of versions(`CREATE TABLE t (id INTEGER PRIMARY KEY ${order}, name TEXT)`)) {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(sql);
        database.exec("INSERT INTO t(name) VALUES ('one')");
        assert.equal(database.prepare("SELECT id FROM t").get()!.id, order === "ASC" ? 1 : null);
      } finally {
        database.close();
      }
    }
  }
});

test("collation and column conflict actions preserve insertion behavior", () => {
  const source = `CREATE TABLE t (
    name TEXT CONSTRAINT names COLLATE NOCASE UNIQUE ON CONFLICT IGNORE,
    fallback TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'fallback'
  )`;
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec("INSERT INTO t VALUES ('A',NULL); INSERT INTO t VALUES ('a','ignored')");
      assert.deepEqual(
        database
          .prepare("SELECT * FROM t")
          .all()
          .map((row) => ({ ...row })),
        [{ fallback: "fallback", name: "A" }],
      );
    } finally {
      database.close();
    }
  }
});

test("generated VIRTUAL and STORED values update correctly and cannot be assigned", () => {
  const source = `CREATE TABLE t (
    a INTEGER, b INTEGER,
    v TEXT COLLATE NOCASE AS (a || ':' || b),
    s INTEGER GENERATED ALWAYS AS (a + b) STORED NOT NULL
  )`;
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      assert.deepEqual(
        database
          .prepare("PRAGMA table_xinfo(t)")
          .all()
          .map((row) => row.hidden),
        [0, 0, 2, 3],
      );
      database.exec("INSERT INTO t(a,b) VALUES (1,2)");
      assert.deepEqual({ ...database.prepare("SELECT v,s FROM t").get()! }, { s: 3, v: "1:2" });
      database.exec("UPDATE t SET a=4");
      assert.deepEqual({ ...database.prepare("SELECT v,s FROM t").get()! }, { s: 6, v: "4:2" });
      assert.throws(() => database.exec("INSERT INTO t(a,b,s) VALUES (1,2,3)"), /generated column/);
    } finally {
      database.close();
    }
  }
});

test("repeated defaults and collation clauses stay ordered rather than being collapsed", () => {
  const source =
    "CREATE TABLE t (a TEXT DEFAULT 'first' DEFAULT 'last' COLLATE BINARY COLLATE NOCASE UNIQUE)";
  const ast = Effect.runSync(createTable.decode(source));
  assert.deepEqual(
    ast.columns[0]!.constraints.map((constraint) => constraint._tag),
    ["Default", "Default", "Collate", "Collate", "Unique"],
  );
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec("INSERT INTO t DEFAULT VALUES");
      assert.equal(database.prepare("SELECT a FROM t").get()!.a, "last");
      assert.throws(() => database.exec("INSERT INTO t VALUES ('LAST')"), /UNIQUE/);
    } finally {
      database.close();
    }
  }
});
