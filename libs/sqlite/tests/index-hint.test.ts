import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { sqlQuery } from "../src/index.ts";

test("table index hints preserve native results and query plans", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(v); CREATE INDEX v_index ON t(v); INSERT INTO t VALUES(1),(2)");
  try {
    for (const source of [
      "SELECT v FROM t INDEXED BY v_index WHERE v = 1",
      "SELECT x.v FROM main.t AS x NOT INDEXED WHERE x.v = 1",
    ]) {
      const value = Effect.runSync(sqlQuery.decode(source));
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(Effect.runSync(sqlQuery.decode(rendered)), value);
      assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all());
      assert.deepEqual(
        db.prepare(`EXPLAIN QUERY PLAN ${rendered}`).all(),
        db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(),
      );
    }
  } finally {
    db.close();
  }
});

test("hints require a table and complete syntax", () => {
  for (const source of [
    "SELECT * FROM t INDEXED",
    "SELECT * FROM t INDEXED BY",
    "SELECT * FROM t NOT",
    "SELECT * FROM t INDEXED BY i AS x",
    "SELECT * FROM f() NOT INDEXED",
    "SELECT * FROM (SELECT 1) INDEXED BY i",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
  assert.ok(
    Result.isFailure(
      Effect.runSync(
        Effect.result(
          sqlQuery.encode({
            _tag: "SelectQuery",
            columns: [{ _tag: "StarColumn" }],
            from: [{ table: { name: "f" }, arguments: [], indexHint: { _tag: "NotIndexed" } }],
          }),
        ),
      ),
    ),
  );
});
