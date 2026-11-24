import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { SchemaDiffError } from "@uncutsql/core";

import { createTableStatement, schema, sqlQuery, toDatabaseSchema } from "../src/index.ts";
const decode = (sql: string) => Effect.runSync(createTableStatement.decode(sql));

test("CREATE TABLE AS preserves data and inferred column names and affinities", () => {
  for (const source of [
    "CREATE TABLE result AS SELECT 1+2, 'a', CAST(1 AS TEXT), ((3*4))",
    "CREATE TABLE result AS SELECT a, a+1, length(b), a COLLATE BINARY FROM input",
    "CREATE TABLE result AS SELECT * FROM input",
    "CREATE TABLE result AS SELECT likely(a), unlikely(a), likelihood(a,0.5) FROM input",
    "CREATE TABLE result AS SELECT * FROM (SELECT a COLLATE BINARY FROM input)",
    "CREATE TABLE result AS WITH x AS (SELECT a COLLATE BINARY FROM input) SELECT * FROM x",
    "CREATE TABLE result AS SELECT 1 STRICT",
    "CREATE TABLE IF NOT EXISTS main.result AS VALUES(1,'a'),(2,'b')",
    "CREATE TEMPORARY TABLE result AS WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<3) SELECT v FROM n",
    "CREATE TABLE result AS SELECT 1+2 UNION SELECT 4+5",
    'CREATE TABLE result AS SELECT "1+2" FROM (SELECT 1+2)',
  ]) {
    const ast = decode(source);
    assert.equal(ast._tag, "CreateTableAs");
    const rendered = Effect.runSync(createTableStatement.encode(ast));
    assert.deepEqual(decode(rendered), ast);
    const snapshot = (sql: string) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          "CREATE TABLE input(a INTEGER, b TEXT); INSERT INTO input VALUES(1,'abc'),(2,'xy')",
        );
        db.exec(sql);
        return [
          db.prepare("PRAGMA table_info(result)").all(),
          db.prepare("SELECT * FROM result").all(),
        ];
      } finally {
        db.close();
      }
    };
    assert.deepEqual(snapshot(rendered), snapshot(source), source);
  }
});

test("query formatting preserves unaliased expression column names", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "SELECT 1+2, ((3*4)), /*lead*/ 5+6",
      'SELECT "1+2" FROM (SELECT 1+2)',
      "WITH x AS (SELECT 1+2) SELECT * FROM x",
    ]) {
      const ast = Effect.runSync(sqlQuery.decode(source));
      const rendered = Effect.runSync(sqlQuery.encode(ast));
      assert.deepEqual(Effect.runSync(sqlQuery.decode(rendered)), ast);
      assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all());
    }
  } finally {
    db.close();
  }
});

test("AS queries round-trip in schemas but require evaluation before schema comparison", () => {
  const ast = Effect.runSync(
    schema.decode("CREATE TABLE input(a); CREATE TABLE result AS SELECT * FROM input;"),
  );
  assert.deepEqual(Effect.runSync(schema.decode(Effect.runSync(schema.encode(ast)))), ast);
  for (const side of ["before", "after"] as const) {
    const result = Effect.runSync(Effect.result(toDatabaseSchema(ast, side)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof SchemaDiffError);
    assert.equal(result.failure.diagnostics[0]!.code, "UnsupportedSchemaStatement");
    assert.equal(result.failure.diagnostics[0]!.side, side);
  }
});

test("AS cannot be mixed with explicit columns or table options", () => {
  for (const sql of [
    "CREATE TABLE t AS",
    "CREATE TABLE t(a) AS SELECT 1",
    "CREATE TABLE t AS SELECT 1 AS value STRICT",
    "CREATE TABLE t AS (SELECT 1)",
    "CREATE TABLE t AS SELECT 1 WITHOUT ROWID",
  ]) {
    assert.ok(
      Result.isFailure(Effect.runSync(Effect.result(createTableStatement.decode(sql)))),
      sql,
    );
  }
});

test("previous CREATE TABLE AS fixture", () => {
  const source = readFileSync(
    new URL("./fixtures/previous/create-table-as/29_create_as_select.sql", import.meta.url),
    "utf8",
  );
  const ast = decode(source);
  const rendered = Effect.runSync(createTableStatement.encode(ast));
  assert.deepEqual(decode(rendered), ast);
  const execute = (sql: string) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sql);
      return [db.prepare("PRAGMA table_info(t)").all(), db.prepare("SELECT * FROM t").all()];
    } finally {
      db.close();
    }
  };
  assert.deepEqual(execute(rendered), execute(source));
});
