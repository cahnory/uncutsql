import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";

import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
import { createTable, encodeMigration, schema, sqlExpression } from "../src/index.ts";
import type { Expression } from "../src/index.ts";
import { planMigration } from "./workflow.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (value: Expression) => Effect.runSync(sqlExpression.encode(value));

test("pattern operators retain SQLite semantics, precedence and ESCAPE", () => {
  const db = new DatabaseSync(":memory:");
  db.function("regexp", (pattern, value) =>
    new RegExp(String(pattern)).test(String(value)) ? 1 : 0,
  );
  db.function("match", (pattern, value) => (String(value).includes(String(pattern)) ? 1 : 0));
  try {
    for (const source of [
      "'Ada' LIKE 'a%'",
      "'æ' LIKE 'Æ'",
      "'Ada' NOT LIKE 'b%'",
      "NULL LIKE '%'",
      "'abc' GLOB 'a*'",
      "'abc' NOT GLOB 'A*'",
      "'a_b' LIKE 'a!_b' ESCAPE '!'",
      "'a%b' NOT LIKE 'a!%b' ESCAPE '!'",
      "'abc' REGEXP '^a'",
      "'abc' NOT REGEXP '^b'",
      "'abc' MATCH 'b'",
      "'abc' NOT MATCH 'd'",
      "NOT 'a' LIKE 'a'",
      "2 LIKE 2 = 1",
      "2 = 2 LIKE 1",
      "2 LIKE 2 < 3",
      "2 LIKE 2 < 3 ESCAPE '!'",
      "'a' LIKE 'a' ESCAPE '!' = 1",
      "'a' LIKE 'a' ESCAPE '!' || ''",
      "'a' LIKE ('a' = 1) ESCAPE '!'",
      "'a' LIKE 'a' ISNULL",
      "'a' LIKE 'a' IN (1)",
      "'a' LIKE 'a' BETWEEN 0 AND 1",
      "1 BETWEEN 0 AND 'a' LIKE 'a'",
      "'a' LIKE 'a' LIKE 1",
      "'a' LIKE ('a' LIKE 1)",
      "'a' || 'b' LIKE 'ab'",
      "'a' COLLATE NOCASE LIKE 'A'",
    ]) {
      const ast = decode(source);
      const sql = encode(ast);
      assert.deepEqual(decode(sql), ast, source);
      assert.deepEqual(
        db.prepare(`SELECT ${sql} AS value`).get(),
        db.prepare(`SELECT ${source} AS value`).get(),
        `${source} -> ${sql}`,
      );
    }
  } finally {
    db.close();
  }
});

test("ESCAPE follows SQLite grammar even for extension-provided pattern functions", () => {
  const db = new DatabaseSync(":memory:");
  db.function("glob", (pattern, value, escape) => `${pattern}:${value}:${escape}`);
  try {
    const source = "'text' GLOB 'pattern' ESCAPE '!'";
    assert.equal(
      db.prepare(`SELECT ${encode(decode(source))} AS value`).get()!.value,
      "pattern:text:!",
    );
  } finally {
    db.close();
  }
  for (const source of [
    "a LIKE",
    "a NOT LIKE",
    "a GLOB",
    "a REGEXP",
    "a MATCH",
    "a LIKE b ESCAPE",
    "a LIKE b = 1 ESCAPE '!'",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
  }
});

test("pattern defaults check operands and escape expressions, even when nested", () => {
  const source = "CREATE TABLE t (a DEFAULT ('abc' LIKE 'a%'))";
  const ast = Effect.runSync(createTable.decode(source));
  assert.deepEqual(
    Effect.runSync(createTable.decode(Effect.runSync(createTable.encode(ast)))),
    ast,
  );
  for (const expression of ["a LIKE 'a%'", "'a' LIKE a", "'a' LIKE 'a' ESCAPE a"]) {
    const result = Effect.runSync(
      Effect.result(createTable.decode(`CREATE TABLE t (a, b DEFAULT (${expression}))`)),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof ParseError);
    const output = Effect.runSync(
      Effect.result(defaultColumnConstraint.encode({ _tag: "Default", value: decode(expression) })),
    );
    assert.ok(Result.isFailure(output));
    assert.ok(output.failure instanceof EncodeError);
  }
});

test("pattern checks and generated columns survive model conversion and rebuild", () => {
  const before = Effect.runSync(schema.decode("CREATE TABLE t (name TEXT)"));
  const after = Effect.runSync(
    schema.decode(
      "CREATE TABLE t (name TEXT CHECK(name LIKE 'a%'), matches INTEGER AS (name GLOB 'A*') STORED)",
    ),
  );
  const sql = Effect.runSync(Effect.flatMap(planMigration(before, after), encodeMigration));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('Ada')");
    db.exec(sql);
    assert.equal(db.prepare("SELECT matches FROM t").get()!.matches, 1);
    assert.throws(() => db.exec("INSERT INTO t(name) VALUES ('Bob')"), /CHECK/);
  } finally {
    db.close();
  }
});
