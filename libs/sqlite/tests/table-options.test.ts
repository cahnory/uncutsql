import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";

import { createTable } from "../src/index.ts";

const versions = (source: string) => {
  const ast = Effect.runSync(createTable.decode(source));
  const encoded = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(encoded)), ast);
  return [source, encoded];
};

test("STRICT preserves coercion and ANY's ability to retain numeric-looking strings", () => {
  for (const sql of versions("CREATE TABLE t (id INT, value ANY) STRICT")) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec("INSERT INTO t VALUES ('1','0001')");
      assert.deepEqual({ ...database.prepare("SELECT * FROM t").get()! }, { id: 1, value: "0001" });
      assert.throws(
        () => database.exec("INSERT INTO t VALUES ('not a number','anything')"),
        /cannot store TEXT/,
      );
    } finally {
      database.close();
    }
  }
});

for (const options of [
  "WITHOUT ROWID",
  "WITHOUT ROWID, STRICT",
  "STRICT, WITHOUT ROWID",
  "STRICT, STRICT, WITHOUT ROWID, WITHOUT ROWID",
]) {
  test(`table option order and repetition: ${options}`, () => {
    for (const sql of versions(
      `CREATE TABLE t (a INTEGER, b TEXT, PRIMARY KEY (a,b)) ${options}`,
    )) {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(sql);
        const flags = database
          .prepare("PRAGMA table_list")
          .all()
          .find((row) => row.name === "t")!;
        assert.equal(flags.wr, 1);
        assert.equal(flags.strict, options.includes("STRICT") ? 1 : 0);
        assert.throws(() => database.prepare("SELECT rowid FROM t"), /no such column/);
      } finally {
        database.close();
      }
    }
  });
}

test("schema-dependent restrictions remain SQLite's responsibility", () => {
  for (const source of [
    "CREATE TABLE t (a INTEGER) WITHOUT ROWID",
    "CREATE TABLE t (a CUSTOM) STRICT",
    "CREATE TABLE t (a INTEGER PRIMARY KEY DESC AUTOINCREMENT)",
    "CREATE TABLE t (a INTEGER PRIMARY KEY, PRIMARY KEY (a))",
  ]) {
    for (const sql of versions(source)) {
      const database = new DatabaseSync(":memory:");
      try {
        assert.throws(() => database.exec(sql));
      } finally {
        database.close();
      }
    }
  }
});

test("options and generated clauses reject incomplete or misplaced syntax", () => {
  for (const source of [
    "CREATE TABLE t (a INT) STRICT,",
    "CREATE TABLE t (a INT) STRICT WITHOUT ROWID",
    "CREATE TABLE t (a INT) WITHOUT",
    "CREATE TABLE t (a INT) ROWID",
    "CREATE TABLE t (a INT) STRICTER",
    "CREATE TABLE t (a INT, b AS (a + 1) STORED VIRTUAL)",
    "CREATE TABLE t (a INT, b GENERATED ALWAYS AS ())",
  ]) {
    const result = Effect.runSync(Effect.result(createTable.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
  }
  const base = Effect.runSync(createTable.decode("CREATE TABLE t (a INT)"));
  const result = Effect.runSync(Effect.result(createTable.encode({ ...base, options: [] })));
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EncodeError);
});
