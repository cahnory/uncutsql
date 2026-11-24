import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";
import type { SourceNode } from "@uncutsql/codec";

import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
import { createTable, encodeMigration, schema, sqlExpression } from "../src/index.ts";
import type { Expression } from "../src/index.ts";
import { planMigration } from "./workflow.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (ast: Expression) => Effect.runSync(sqlExpression.encode(ast));
const ref: Expression = { _tag: "ColumnReference", parts: ["a"] };

test("previous COLLATE fixture and unary/concatenation boundaries retain AST structure", () => {
  const fixture = readFileSync(
    new URL("./fixtures/expression/07_collate.sql", import.meta.url),
    "utf8",
  );
  assert.deepEqual(decode(fixture), {
    _tag: "CollateExpression",
    collation: "NOCASE",
    operand: ref,
  });
  assert.deepEqual(decode("-a COLLATE NOCASE"), {
    _tag: "CollateExpression",
    collation: "NOCASE",
    operand: { _tag: "UnaryExpression", operand: ref, operator: "-" },
  });
  assert.equal(decode("NOT a COLLATE NOCASE")._tag, "UnaryExpression");
  assert.equal(decode("a || a COLLATE NOCASE")._tag, "BinaryExpression");
  const grouped: Expression = {
    _tag: "UnaryExpression",
    operand: { _tag: "CollateExpression", collation: "NOCASE", operand: ref },
    operator: "-",
  };
  assert.equal(encode(grouped), '-("a" COLLATE "NOCASE")');
  assert.deepEqual(decode(encode(grouped)), grouped);
});

test("COLLATE preserves native comparison results, nesting and operand precedence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "'A' COLLATE NOCASE = 'a'",
      "'A' = 'a' COLLATE NOCASE",
      "'A' COLLATE BINARY = 'a' COLLATE NOCASE",
      "'A' COLLATE NOCASE = 'a' COLLATE BINARY",
      "'A' COLLATE NOCASE COLLATE BINARY = 'a'",
      "'A' COLLATE BINARY COLLATE NOCASE = 'a'",
      "'A ' COLLATE RTRIM = 'A'",
      "('A' || 'B') COLLATE NOCASE = 'ab'",
      "'A' COLLATE NOCASE || 'B' = 'ab'",
      "'A' || 'B' COLLATE NOCASE = 'ab'",
      "NOT 'A' COLLATE NOCASE = 'a'",
      "+'A' COLLATE NOCASE = 'a'",
      "-(1 COLLATE NOCASE) + 2",
      "1 + 2 COLLATE NOCASE * 3",
      "('A' COLLATE NOCASE) IN ('a','b')",
      "'A' COLLATE NOCASE BETWEEN 'a' AND 'b'",
      "'A' COLLATE NOCASE ISNULL",
      "lower('A' COLLATE NOCASE) = 'a'",
    ]) {
      const ast = decode(source);
      const sql = encode(ast);
      assert.deepEqual(decode(sql), ast, source);
      assert.deepEqual(
        db.prepare(`SELECT ${sql} AS value`).get(),
        db.prepare(`SELECT ${source} AS value`).get(),
        source,
      );
    }
  } finally {
    db.close();
  }
});

test("collation names quote safely and malformed suffixes commit parse failures", () => {
  for (const collation of ["select", "custom name", 'a"b', "NOCASE"]) {
    const ast: Expression = { _tag: "CollateExpression", collation, operand: ref };
    assert.deepEqual(decode(encode(ast)), ast);
  }
  for (const source of [
    "a COLLATE",
    "a COLLATE SELECT",
    'a COLLATE "unfinished',
    "a COLLATE NOCASE COLLATE",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof ParseError);
    assert.equal(result.failure.committed, true);
  }
  const bad = Effect.runSync(
    Effect.result(
      sqlExpression.encode({ _tag: "CollateExpression", collation: "bad\0name", operand: ref }),
    ),
  );
  assert.ok(Result.isFailure(bad));
  assert.ok(bad.failure instanceof EncodeError);
});

test("defaults retain expression grouping and cannot hide a column behind COLLATE", () => {
  const ast = Effect.runSync(
    createTable.decode("CREATE TABLE t (value DEFAULT ('A' COLLATE NOCASE))"),
  );
  assert.deepEqual(
    Effect.runSync(createTable.decode(Effect.runSync(createTable.encode(ast)))),
    ast,
  );
  const bad = Effect.runSync(
    Effect.result(createTable.decode("CREATE TABLE t (a, b DEFAULT (a COLLATE NOCASE))")),
  );
  assert.ok(Result.isFailure(bad));
  assert.ok(bad.failure instanceof ParseError);
  const encoded = Effect.runSync(
    Effect.result(
      defaultColumnConstraint.encode({
        _tag: "Default",
        value: { _tag: "CollateExpression", collation: "NOCASE", operand: ref },
      }),
    ),
  );
  assert.ok(Result.isFailure(encoded));
  assert.ok(encoded.failure instanceof EncodeError);
  const separate = Effect.runSync(
    createTable.decode("CREATE TABLE t (value DEFAULT 'A' COLLATE NOCASE)"),
  );
  assert.deepEqual(
    separate.columns[0]!.constraints.map((c) => c._tag),
    ["Default", "Collate"],
  );
});

test("COLLATE survives model conversion and rebuild migration with generated values and checks", () => {
  const before = Effect.runSync(schema.decode("CREATE TABLE t (name TEXT)"));
  const after = Effect.runSync(
    schema.decode(
      "CREATE TABLE t (name TEXT CHECK (name COLLATE NOCASE = 'ada'), is_ada INTEGER AS (name COLLATE NOCASE = 'ada') STORED)",
    ),
  );
  const sql = Effect.runSync(Effect.flatMap(planMigration(before, after), encodeMigration));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('ADA')");
    db.exec(sql);
    assert.equal(db.prepare("SELECT is_ada FROM t").get()!.is_ada, 1);
    assert.throws(() => db.exec("INSERT INTO t(name) VALUES ('Bob')"), /CHECK/);
  } finally {
    db.close();
  }
});

test("COLLATE source maps include operands and exact collation identifier spans", () => {
  const source = " (a || a) COLLATE /*name*/ [NOCASE]";
  const parsed = Effect.runSync(sqlExpression.decodeWithSourceMap(source));
  const flatten = (nodes: readonly SourceNode[]): readonly SourceNode[] =>
    nodes.flatMap((n) => [n, ...flatten(n.children)]);
  const node = flatten(parsed.sourceMap).find((n) => n.kind === "CollateExpression")!;
  assert.equal(source.slice(node.start, node.end), source.trimStart());
  assert.ok(
    flatten(node.children).some(
      (n) => n.kind === "Identifier" && source.slice(n.start, n.end) === "[NOCASE]",
    ),
  );
});
