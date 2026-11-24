import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { createTable, sqlExpression, sqlQuery } from "../src/index.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));

test("query expressions preserve native scalar, row and membership semantics", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(v); INSERT INTO t VALUES(1),(2),(NULL)");
  try {
    for (const source of [
      "(SELECT 1)",
      "((SELECT 1)) + 2",
      "(SELECT v FROM t ORDER BY v DESC LIMIT 1)",
      "(SELECT v FROM t WHERE 0)",
      "(VALUES (1),(2))",
      "(SELECT 1,2) = (1,2)",
      "EXISTS (SELECT NULL)",
      "NOT EXISTS (SELECT 1 WHERE 0)",
      "EXISTS (VALUES (NULL))",
      "1 IN (SELECT v FROM t)",
      "3 NOT IN (SELECT v FROM t)",
      "NULL IN (SELECT v FROM t WHERE 0)",
      "(1,2) IN (VALUES (1,2),(3,4))",
      "2 IN (SELECT 1 UNION SELECT 2)",
      "1 IN ((SELECT 1))",
      "0 = 1 IN (SELECT 1)",
      "NOT 1 IN (SELECT 1)",
      "(SELECT (SELECT 1) + 1)",
      "coalesce((SELECT NULL), 2)",
    ]) {
      const value = decode(source);
      const rendered = Effect.runSync(sqlExpression.encode(value));
      assert.deepEqual(decode(rendered), value);
      assert.deepEqual(
        db.prepare(`SELECT ${rendered} AS result`).get(),
        db.prepare(`SELECT ${source} AS result`).get(),
        source,
      );
    }
    assert.equal(decode("1 IN (SELECT 1)")._tag, "InQueryExpression");
    assert.equal(decode("1 IN ((SELECT 1))")._tag, "InExpression");
    const source =
      "SELECT a.v, (SELECT count(*) FROM t b WHERE b.v = a.v) AS n FROM t a WHERE EXISTS (SELECT 1 FROM t b WHERE b.v = a.v) ORDER BY a.v";
    const value = Effect.runSync(sqlQuery.decode(source));
    const rendered = Effect.runSync(sqlQuery.encode(value));
    assert.deepEqual(Effect.runSync(sqlQuery.decode(rendered)), value);
    assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all());
    const bound = "SELECT (SELECT ?) AS a, ? IN (SELECT ? UNION SELECT ?) AS b LIMIT ?";
    const encoded = Effect.runSync(sqlQuery.encode(Effect.runSync(sqlQuery.decode(bound))));
    assert.deepEqual(db.prepare(encoded).all(5, 2, 1, 2, 1), db.prepare(bound).all(5, 2, 1, 2, 1));
  } finally {
    db.close();
  }
});

test("incomplete subqueries fail and DEFAULT rejects nested database reads", () => {
  for (const source of [
    "(SELECT)",
    "(SELECT 1;)",
    "EXISTS ()",
    "EXISTS (1)",
    "EXISTS SELECT 1",
    "1 IN (SELECT)",
    "1 IN (SELECT 1,)",
    "(SELECT 1 UNION)",
  ]) {
    assert.ok(
      Result.isFailure(Effect.runSync(Effect.result(sqlExpression.decode(source)))),
      source,
    );
  }
  for (const source of [
    "(SELECT 1)",
    "EXISTS (SELECT 1)",
    "1 IN (SELECT 1)",
    "coalesce((SELECT 1), 2)",
  ]) {
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(createTable.decode(`CREATE TABLE t(a DEFAULT (${source}))`))),
      ),
      source,
    );
  }
});

test("SQLite validates subquery use in CHECK and generated-column contexts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "CREATE TABLE t(a CHECK ((SELECT 1)))",
      "CREATE TABLE t(a, b AS ((SELECT 1)))",
    ]) {
      const value = Effect.runSync(createTable.decode(source));
      const rendered = Effect.runSync(createTable.encode(value));
      assert.deepEqual(Effect.runSync(createTable.decode(rendered)), value);
      assert.throws(() => db.exec(source), /subqueries prohibited/);
      assert.throws(() => db.exec(rendered), /subqueries prohibited/);
    }
  } finally {
    db.close();
  }
});
