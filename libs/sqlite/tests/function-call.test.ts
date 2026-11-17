import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { createTable, type Expression } from "../src/index.ts";
import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";

test("calls in defaults, checks and generated columns retain SQLite behavior", () => {
  const source = `CREATE TABLE t (
    name TEXT DEFAULT (lower('ABC')) CHECK (length(name) > 0),
    created TEXT DEFAULT (datetime('now')),
    size INTEGER GENERATED ALWAYS AS (length(name)) STORED
  )`;
  const ast = Effect.runSync(createTable.decode(source));
  const sql = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
  for (const statement of [source, sql]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(statement);
      database.exec("INSERT INTO t DEFAULT VALUES");
      assert.deepEqual(
        { ...database.prepare("SELECT name, size, created IS NOT NULL AS dated FROM t").get() },
        { name: "abc", size: 3, dated: 1 },
      );
      assert.throws(() => database.exec("INSERT INTO t (name) VALUES ('')"), /CHECK/);
    } finally {
      database.close();
    }
  }
});

test("defaults reject column references nested inside calls in both directions", () => {
  const sql = "CREATE TABLE t (a, b DEFAULT (abs(coalesce(a, 0))))";
  assert.ok(Result.isFailure(Effect.runSync(Effect.result(createTable.decode(sql)))));
  const value: Expression = {
    _tag: "FunctionCall",
    name: "abs",
    arguments: [{ _tag: "ColumnReference", parts: ["a"] }],
  };
  assert.ok(
    Result.isFailure(
      Effect.runSync(Effect.result(defaultColumnConstraint.encode({ _tag: "Default", value }))),
    ),
  );
});
