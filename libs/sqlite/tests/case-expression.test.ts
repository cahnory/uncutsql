import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";
import type { SourceNode } from "@uncutsql/codec";

import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
import { createTable, encodeMigration, schema, sqlExpression } from "../src/index.ts";
import type { CaseExpression, Expression } from "../src/index.ts";
import { planMigration } from "./workflow.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (ast: Expression) => Effect.runSync(sqlExpression.encode(ast));

test("previous CASE fixtures and nested branches round-trip", () => {
  const fixture = readFileSync(
    new URL("./fixtures/expression/06_case.sql", import.meta.url),
    "utf8",
  );
  const ast = decode(fixture);
  assert.deepEqual(decode(encode(ast)), ast);
  const invalid = readFileSync(
    new URL("./fixtures/expression/03_bad_case.sql", import.meta.url),
    "utf8",
  );
  assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlExpression.decode(invalid)))));
  const simple = decode("CASE a WHEN 1 THEN 2 END");
  assert.equal(simple._tag, "CaseExpression");
  if (simple._tag === "CaseExpression") {
    assert.equal(simple.base!._tag, "ColumnReference");
    assert.equal("else" in simple, false);
  }
  const searched = decode("CASE WHEN a THEN 2 ELSE NULL END");
  assert.equal(searched._tag, "CaseExpression");
  if (searched._tag === "CaseExpression") {
    assert.equal("base" in searched, false);
    assert.deepEqual(searched.else, { _tag: "NullLiteral" });
  }
  for (const sql of [
    "CASE WHEN a BETWEEN 1 AND 2 THEN CASE a WHEN 1 THEN 3 ELSE 4 END ELSE 5 END + 1",
    "CASE CASE WHEN a THEN 1 END WHEN 1 THEN 2 END",
    "CASE WHEN a IN (1,2) THEN CAST(3 AS TEXT) ELSE 4 END COLLATE NOCASE",
    "CASE WHEN CASE WHEN a THEN 1 END THEN 2 END",
    "CASE WHEN a THEN 1 WHEN a THEN 2 ELSE 3 END",
  ]) {
    const value = decode(sql);
    assert.deepEqual(decode(encode(value)), value);
  }
});

test("CASE retains native values, NULL semantics, collation and branch evaluation", () => {
  const db = new DatabaseSync(":memory:");
  let calls = 0;
  db.function("tick", () => {
    calls++;
    return 2;
  });
  db.function("explode", () => {
    throw Error("unexpected evaluation");
  });
  try {
    for (const source of [
      "CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'other' END",
      "CASE NULL WHEN NULL THEN 1 ELSE 2 END",
      "CASE WHEN NULL THEN 1 END",
      "CASE 'ADA' COLLATE NOCASE WHEN 'ada' THEN 1 ELSE 0 END",
      "CASE WHEN 1 THEN 1.5 ELSE 0 END",
      "CASE WHEN 0 THEN 1 ELSE NULL END",
      "CASE WHEN 1 THEN 2 ELSE explode() END",
      "CASE WHEN 0 THEN explode() ELSE 3 END",
      "CASE WHEN 1 THEN 2 WHEN explode() THEN 3 END",
      "CASE tick() WHEN 1 THEN 3 WHEN 2 THEN 4 WHEN explode() THEN 5 END",
    ]) {
      const ast = decode(source);
      const sql = encode(ast);
      assert.deepEqual(decode(sql), ast);
      const evaluate = (text: string) => {
        calls = 0;
        const row = db.prepare(`SELECT (${text}) AS value`).get();
        return { calls, row };
      };
      const original = evaluate(source);
      assert.deepEqual(evaluate(sql), original, source);
      if (source.includes("tick()")) {
        assert.equal(original.calls, 1);
      }
    }
  } finally {
    db.close();
  }
});

test("CASE rejects incomplete syntax and empty constructed branch lists", () => {
  for (const source of [
    "CASE",
    "CASE END",
    "CASE 1 END",
    "CASE THEN 1 END",
    "CASE WHEN THEN 1 END",
    "CASE WHEN 1 THEN END",
    "CASE WHEN 1 THEN 2",
    "CASE WHEN 1 THEN 2 ELSE END",
    "CASE WHEN 1 THEN 2 ELSE 3 WHEN 4 THEN 5 END",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
    assert.equal(result.failure.committed, true);
  }
  const result = Effect.runSync(
    Effect.result(sqlExpression.encode({ _tag: "CaseExpression", branches: [] })),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EncodeError);
});

test("CASE defaults stay grouped and check all branches for column references", () => {
  const ast = Effect.runSync(
    createTable.decode("CREATE TABLE t (a DEFAULT (CASE WHEN 0 THEN 2 ELSE 3 END))"),
  );
  const sql = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    db.exec("INSERT INTO t DEFAULT VALUES");
    assert.equal(db.prepare("SELECT a FROM t").get()!.a, 3);
  } finally {
    db.close();
  }
  for (const source of [
    "CASE a WHEN 1 THEN 2 END",
    "CASE WHEN a THEN 2 END",
    "CASE WHEN 0 THEN a ELSE 2 END",
    "CASE WHEN 1 THEN 2 ELSE a END",
  ]) {
    const result = Effect.runSync(
      Effect.result(createTable.decode(`CREATE TABLE t (a, b DEFAULT (${source}))`)),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof ParseError);
    const encoded = Effect.runSync(
      Effect.result(defaultColumnConstraint.encode({ _tag: "Default", value: decode(source) })),
    );
    assert.ok(Result.isFailure(encoded));
    assert.ok(encoded.failure instanceof EncodeError);
  }
});

test("CASE survives schema model conversion and generated/check rebuilds", () => {
  const before = Effect.runSync(schema.decode("CREATE TABLE t (age INTEGER)"));
  const after = Effect.runSync(
    schema.decode(
      "CREATE TABLE t (age INTEGER CHECK(CASE WHEN age >= 18 THEN 1 ELSE 0 END), category TEXT AS (CASE WHEN age >= 18 THEN 'adult' ELSE 'child' END) STORED)",
    ),
  );
  const sql = Effect.runSync(Effect.flatMap(planMigration(before, after), encodeMigration));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (age INTEGER); INSERT INTO t VALUES (21)");
    db.exec(sql);
    assert.equal(db.prepare("SELECT category FROM t").get()!.category, "adult");
    assert.throws(() => db.exec("INSERT INTO t(age) VALUES (10)"), /CHECK/);
  } finally {
    db.close();
  }
});

test("CASE source map spans include nested CASE nodes", () => {
  const source = " CASE WHEN 1 THEN CASE 2 WHEN 2 THEN 3 END ELSE 4 END";
  const parsed = Effect.runSync(sqlExpression.decodeWithSourceMap(source));
  const flatten = (nodes: readonly SourceNode[]): readonly SourceNode[] =>
    nodes.flatMap((n) => [n, ...flatten(n.children)]);
  const nodes = flatten(parsed.sourceMap).filter((n) => n.kind === "CaseExpression");
  assert.equal(nodes.length, 2);
  assert.equal(source.slice(nodes[0]!.start, nodes[0]!.end), source.trimStart());
  const constructed: CaseExpression = {
    _tag: "CaseExpression",
    branches: [
      { condition: { _tag: "NumericLiteral", value: "1" }, result: { _tag: "NullLiteral" } },
    ],
  };
  assert.deepEqual(decode(encode(constructed)), constructed);
});
