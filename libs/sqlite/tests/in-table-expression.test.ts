import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { createTable, sqlExpression } from "../src/index.ts";
import type { InTableExpression } from "../src/index.ts";
const decode = (source: string) => Effect.runSync(sqlExpression.decode(source));

test("IN table and table-function targets retain native SQLite semantics", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE t(value); INSERT INTO t VALUES(1),(NULL); CREATE TABLE pairs(a,b); INSERT INTO pairs VALUES(1,2); CREATE TEMP TABLE temp_values(x); INSERT INTO temp_values VALUES(3)",
  );
  try {
    for (const source of [
      "1 IN t",
      "2 NOT IN main.t",
      "NULL IN t",
      "3 IN temp.temp_values",
      "(1,2) IN pairs",
      "(2,1) NOT IN main.pairs",
      "0 = 1 IN t",
      "1 IN t = 1",
      "NOT 2 IN t",
      "1 IN t AND 0",
      "('main','t','table',1,0,0) IN pragma_table_list()",
    ]) {
      const value = decode(source);
      const encoded = Effect.runSync(sqlExpression.encode(value));
      assert.deepEqual(decode(encoded), value);
      assert.deepEqual(
        db.prepare(`SELECT ${encoded} AS result`).get(),
        db.prepare(`SELECT ${source} AS result`).get(),
        source,
      );
    }
    // pragma_table_info has six columns: use a six-value row on the left.
    const source = "(0,'value','',0,NULL,0) IN pragma_table_info('t')";
    const encoded = Effect.runSync(sqlExpression.encode(decode(source)));
    assert.deepEqual(
      db.prepare(`SELECT ${encoded} AS result`).get(),
      db.prepare(`SELECT ${source} AS result`).get(),
    );
  } finally {
    db.close();
  }
});

test("table targets distinguish tables from functions with empty arguments", () => {
  const table = decode('1 IN "a.b"') as InTableExpression;
  assert.deepEqual(table.target, { table: { name: "a.b" } });
  const call = decode("1 IN main.f()") as InTableExpression;
  assert.deepEqual(call.target, { arguments: [], table: { name: "f", schema: "main" } });
  for (const source of ["1 IN f()", "1 IN f(1, 2 + 3)", "1 IN main.f(?)", "1 IN ()"]) {
    const value = decode(source);
    assert.deepEqual(decode(Effect.runSync(sqlExpression.encode(value))), value);
  }
});

test("malformed targets fail and table reads cannot be defaults", () => {
  for (const source of ["1 IN", "1 IN main.", "1 IN a.b.c", "1 IN f(", "1 IN f(,)", "1 IN f(1,)"]) {
    assert.ok(
      Result.isFailure(Effect.runSync(Effect.result(sqlExpression.decode(source)))),
      source,
    );
  }
  for (const source of ["1 IN t", "1 NOT IN f()", "coalesce(1 IN t, 0)"]) {
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(createTable.decode(`CREATE TABLE a(x DEFAULT (${source}))`))),
      ),
      source,
    );
  }
});
