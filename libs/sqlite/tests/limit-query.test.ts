import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { sqlQuery } from "../src/index.ts";
const decode = (sql: string) => Effect.runSync(sqlQuery.decode(sql));

test("LIMIT preserves count/offset semantics and anonymous binding order", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(v); INSERT INTO t VALUES(1),(2),(3),(4),(5)");
  try {
    for (const clause of [
      "LIMIT 2",
      "LIMIT 2 OFFSET 1",
      "LIMIT 1, 2",
      "LIMIT -1 OFFSET 2",
      "LIMIT 2 OFFSET -1",
      "LIMIT 0",
      "LIMIT 1 + 1 OFFSET 3 - 1",
      "LIMIT ?, ?",
      "LIMIT ? OFFSET ?",
    ]) {
      const source = `SELECT v FROM t ORDER BY v ${clause}`;
      const value = decode(source);
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(decode(rendered), value);
      const params = clause.includes("?") ? [1, 2] : [];
      assert.deepEqual(
        db.prepare(rendered).all(...params),
        db.prepare(source).all(...params),
        source,
      );
    }
    const comma = decode("SELECT 1 LIMIT 2, 3");
    assert.equal(comma._tag, "SelectQuery");
    if (comma._tag === "SelectQuery") {
      assert.deepEqual(comma.limit, {
        _tag: "CommaLimit",
        count: { _tag: "NumericLiteral", value: "3" },
        offset: { _tag: "NumericLiteral", value: "2" },
      });
    }
  } finally {
    db.close();
  }
});

test("incomplete and misplaced LIMIT clauses fail", () => {
  for (const source of [
    "SELECT 1 LIMIT",
    "SELECT 1 LIMIT 1 OFFSET",
    "SELECT 1 LIMIT 1,",
    "SELECT 1 LIMIT 1,2,3",
    "SELECT 1 OFFSET 2",
    "SELECT 1 LIMIT 1 ORDER BY 1",
    "VALUES (1) LIMIT 1",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
});
