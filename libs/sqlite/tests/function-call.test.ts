import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
import { createTable, sqlExpression, sqlQuery } from "../src/index.ts";
import type { Expression } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";

test("bare function names match native SQLite for every dialect keyword", () => {
  using db = new DatabaseSync(":memory:");
  for (const keyword of keywords) {
    const name = keyword[0] + keyword.slice(1).toLowerCase();
    db.function(name, () => 7);
    const source = `${name}()`;
    const parsed = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    let native;
    try {
      native = db.prepare(`SELECT ${source}`);
    } catch {
      assert.ok(Result.isFailure(parsed), source);
      continue;
    }
    assert.ok(Result.isSuccess(parsed), source);
    assert.deepEqual(parsed.success, { _tag: "FunctionCall", arguments: [], name }, source);
    assert.equal(native.get()?.[source], 7, source);
  }
});

test("formatting preserves the Replace result label and value", () => {
  using db = new DatabaseSync(":memory:");
  const label = "Replace('abc', 'b', 'x')";
  const source = `SELECT ${label}`;
  const parsed = Effect.runSync(sqlQuery.decode(source));
  const rendered = Effect.runSync(sqlQuery.encode(parsed));
  assert.deepEqual(Effect.runSync(sqlQuery.decode(rendered)), parsed);
  for (const sql of [source, rendered]) {
    assert.deepEqual({ ...db.prepare(sql).get() }, { [label]: "axc" });
  }
});

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
        { dated: 1, name: "abc", size: 3 },
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
    arguments: [{ _tag: "ColumnReference", parts: ["a"] }],
    name: "abs",
  };
  assert.ok(
    Result.isFailure(
      Effect.runSync(Effect.result(defaultColumnConstraint.encode({ _tag: "Default", value }))),
    ),
  );
});
