import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { ParseError } from "@uncutsql/codec";

import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
import { binaryPrecedence } from "../src/codecs/expression/operators.ts";
import { createTable, sqlExpression } from "../src/index.ts";
import type { Expression } from "../src/index.ts";

const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (value: Expression) => Effect.runSync(sqlExpression.encode(value));

test("BETWEEN preserves SQLite precedence, bounds and NULL behavior", () => {
  const database = new DatabaseSync(":memory:");
  const sources = [
    "2 BETWEEN 1 AND 3",
    "2 NOT BETWEEN 1 AND 3",
    "NULL BETWEEN 1 AND 3",
    "2 BETWEEN NULL AND 3",
    "2 NOT BETWEEN 1 AND NULL",
    "NOT 2 BETWEEN 1 AND 3",
    "2 BETWEEN NOT 0 AND 3",
    "2 BETWEEN 0 BETWEEN 0 AND 1 AND 3",
    "2 BETWEEN 0 AND 3 BETWEEN 0 AND 1",
    "2 BETWEEN 0 AND (3 BETWEEN 0 AND 1)",
    "2 BETWEEN (0 OR 1) AND 3",
    "2 BETWEEN 0 AND 3 AND 0",
    "2 BETWEEN 0 AND 3 OR 0",
    "abs(-2) NOT /* trivia */ BETWEEN 0 AND 1",
    "2 BETWEEN 0 AND 3 ISNULL",
    "2 ISNULL BETWEEN 0 AND 3",
    "2 BETWEEN 0 ISNULL AND 3",
  ];
  for (const operator of Object.keys(binaryPrecedence)) {
    sources.push(
      `2 ${operator} 1 BETWEEN 0 AND 3`,
      `2 BETWEEN (0 ${operator} 1) AND 3`,
      `2 BETWEEN 0 AND 3 ${operator} 1`,
    );
  }
  try {
    for (const source of sources) {
      const ast = decode(source);
      const sql = encode(ast);
      assert.deepEqual(decode(sql), ast, source);
      const evaluate = (text: string) => database.prepare(`SELECT (${text}) AS v`).get()!.v;
      assert.equal(evaluate(sql), evaluate(source), `${source} -> ${sql}`);
    }
  } finally {
    database.close();
  }
});

test("BETWEEN tree shape and grouping preserve all three operands", () => {
  const ast = decode("a BETWEEN b AND c");
  assert.deepEqual(ast, {
    _tag: "BetweenExpression",
    lower: { _tag: "ColumnReference", parts: ["b"] },
    operand: { _tag: "ColumnReference", parts: ["a"] },
    operator: "BETWEEN",
    upper: { _tag: "ColumnReference", parts: ["c"] },
  });
  for (const source of [
    "(a OR b) BETWEEN c AND 3",
    "a BETWEEN (b AND c) AND 3",
    "a BETWEEN b AND (c OR 3)",
  ]) {
    assert.deepEqual(decode(encode(decode(source))), decode(source));
  }
});

test("incomplete BETWEEN bounds and delimiters produce committed errors", () => {
  for (const source of [
    "1 BETWEEN",
    "1 NOT BETWEEN",
    "1 BETWEEN 0",
    "1 BETWEEN 0 AND",
    "1 BETWEEN AND 2",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
    assert.equal(result.failure.committed, true, source);
  }
});

test("BETWEEN works in CHECK and DEFAULT and validates each default operand", () => {
  const source = "CREATE TABLE t (a DEFAULT (2 BETWEEN 1 AND 3) CHECK (a BETWEEN 0 AND 1))";
  const ast = Effect.runSync(createTable.decode(source));
  const sql = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
  for (const statement of [source, sql]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(statement);
      database.exec("INSERT INTO t DEFAULT VALUES");
      assert.equal(database.prepare("SELECT a FROM t").get()!.a, 1);
      assert.throws(() => database.exec("INSERT INTO t VALUES (2)"), /CHECK/);
    } finally {
      database.close();
    }
  }
  for (const text of ["a BETWEEN 0 AND 1", "0 BETWEEN a AND 1", "0 BETWEEN 1 AND a"]) {
    const value = decode(text);
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(defaultColumnConstraint.encode({ _tag: "Default", value }))),
      ),
    );
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(createTable.decode(`CREATE TABLE t (a DEFAULT (${text}))`))),
      ),
    );
  }
});

test("BETWEEN evaluates its operand once and retains source spans", () => {
  const source = "tick() NOT BETWEEN 1 AND 3";
  const parsed = Effect.runSync(sqlExpression.decodeWithSourceMap(source));
  const node = parsed.sourceMap.find((node) => node.kind === "BetweenExpression");
  assert.ok(node);
  assert.equal(source.slice(node.start, node.end), source);
  const database = new DatabaseSync(":memory:");
  let calls = 0;
  database.function("tick", () => {
    calls++;
    return 2;
  });
  try {
    for (const sql of [source, encode(parsed.value)]) {
      calls = 0;
      assert.equal(database.prepare(`SELECT ${sql} AS v`).get()!.v, 0);
      assert.equal(calls, 1);
    }
  } finally {
    database.close();
  }
});
