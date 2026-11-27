import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";
import type { SourceNode } from "@uncutsql/codec";

import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
import { createTable, encodeMigration, schema, sqlExpression } from "../src/index.ts";
import type { Expression } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";
import { planMigration } from "./workflow.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (ast: Expression) => Effect.runSync(sqlExpression.encode(ast));

test("CAST conversions retain native SQLite values and types", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "CAST('123' AS INTEGER)",
      "CAST('123e+5' AS INTEGER)",
      "CAST('123e+5' AS NUMERIC)",
      "CAST('bad' AS INTEGER)",
      "CAST(4.9 AS INT)",
      "CAST(NULL AS TEXT)",
      "CAST(1 AS REAL) / 2",
      "CAST(X'3132' AS TEXT)",
      "CAST('abc' AS BLOB)",
      "CAST('9223372036854775807' AS INTEGER)",
      "CAST('9999999999999999999999' AS INTEGER)",
      "CAST(4.5 AS CUSTOM /* INT */ TYPE)",
      "CAST(4.5 AS NUMERIC(10, 2))",
      'CAST(4.5 AS "DOUBLE" "PRECISION")',
      "CAST(4.5 AS DOUBLE PRECISION)",
      "CAST(4.5 AS Generated Always)",
      "CAST(4.5 AS 'double precision')",
      "CAST(4.5 AS 'owner''s' 'TEXT'(+10, -2))",
      "CAST(4.5 AS Replace 'INT' (1e2, 2))",
      "CAST(CAST('2' AS INTEGER) + 1 AS TEXT) || 'x'",
      "-CAST('3' AS INTEGER) * 2",
      "CAST('ADA' AS TEXT) COLLATE NOCASE = 'ada'",
      "CAST('{\"x\":2}' ->> 'x' AS REAL)",
    ]) {
      const ast = decode(source);
      const sql = encode(ast);
      assert.deepEqual(decode(sql), ast, source);
      const evaluate = (text: string) => {
        const stmt = db.prepare(`SELECT (${text}) AS value, typeof(${text}) AS type`);
        stmt.setReadBigInts(true);
        return stmt.get();
      };
      assert.deepEqual(evaluate(sql), evaluate(source), source);
    }
  } finally {
    db.close();
  }
});

test("bare keyword CAST type words match SQLite in the first and subsequent positions", () => {
  using database = new DatabaseSync(":memory:");
  const evaluate = (sql: string) =>
    database.prepare(`SELECT ${sql} AS value, typeof(${sql}) AS storage`).get();
  for (const word of keywords) {
    const token = word[0] + word.slice(1).toLowerCase();
    for (const typeName of [token, `TEXT ${token}`]) {
      const source = `CAST(4.5 AS ${typeName})`;
      const parsed = Effect.runSync(Effect.result(sqlExpression.decode(source)));
      let before;
      try {
        before = evaluate(source);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.match(error.message, /syntax error/, source);
        assert.ok(Result.isFailure(parsed), source);
        continue;
      }
      assert.ok(Result.isSuccess(parsed), source);
      assert.equal(parsed.success._tag, "CastExpression");
      assert.equal(parsed.success.typeName, typeName);
      assert.deepEqual(evaluate(encode(parsed.success)), before, source);
    }
  }
});

test("CAST keeps its own node, type spelling and identifier boundaries", () => {
  const ast = decode("cast /*x*/ (a + 1 as NUMERIC(10, 2))");
  assert.equal(ast._tag, "CastExpression");
  assert.equal(encode(ast), 'CAST("a" + 1 AS NUMERIC(10, 2))');
  assert.equal(decode("cast_value")._tag, "ColumnReference");
  assert.equal(decode('"CAST"(1)')._tag, "FunctionCall");
  const parsed = Effect.runSync(sqlExpression.decodeWithSourceMap(" CAST(a AS TEXT)"));
  const flatten = (nodes: readonly SourceNode[]): readonly SourceNode[] =>
    nodes.flatMap((n) => [n, ...flatten(n.children)]);
  const node = flatten(parsed.sourceMap).find((n) => n.kind === "CastExpression")!;
  assert.equal(parsed.source.slice(node.start, node.end), "CAST(a AS TEXT)");
});

test("malformed CAST syntax commits; constructed type names cannot inject SQL", () => {
  for (const source of [
    "CAST",
    "CAST()",
    "CAST(1)",
    "CAST(AS TEXT)",
    "CAST(1 AS)",
    "CAST(1 AS TEXT",
    "CAST(1 AS TEXT())",
    "CAST(1 AS TEXT(1,2,3))",
    "CAST(1 AS SELECT)",
    "CAST(1,2 AS TEXT)",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
    assert.equal(result.failure.committed, true, source);
  }
  const result = Effect.runSync(
    Effect.result(
      sqlExpression.encode({
        _tag: "CastExpression",
        operand: { _tag: "NumericLiteral", value: "1" },
        typeName: "TEXT); SELECT 1; --",
      }),
    ),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EncodeError);
});

test("CAST defaults stay grouped and reject hidden column references", () => {
  const ast = Effect.runSync(
    createTable.decode("CREATE TABLE t (a DEFAULT (CAST('12' AS INTEGER)))"),
  );
  const sql = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    db.exec("INSERT INTO t DEFAULT VALUES");
    assert.equal(db.prepare("SELECT a FROM t").get()!.a, 12);
  } finally {
    db.close();
  }
  const result = Effect.runSync(
    Effect.result(createTable.decode("CREATE TABLE t (a, b DEFAULT (CAST(a AS TEXT)))")),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof ParseError);
  const encoded = Effect.runSync(
    Effect.result(
      defaultColumnConstraint.encode({
        _tag: "Default",
        value: {
          _tag: "CastExpression",
          operand: { _tag: "ColumnReference", parts: ["a"] },
          typeName: "TEXT",
        },
      }),
    ),
  );
  assert.ok(Result.isFailure(encoded));
  assert.ok(encoded.failure instanceof EncodeError);
});

test("CAST survives model conversion and rebuilds with CHECK and generated expressions", () => {
  const before = Effect.runSync(schema.decode("CREATE TABLE t (value TEXT)"));
  const after = Effect.runSync(
    schema.decode(
      "CREATE TABLE t (value TEXT CHECK(CAST(value AS INTEGER) >= 18), age INTEGER AS (CAST(value AS INTEGER)) STORED)",
    ),
  );
  const sql = Effect.runSync(Effect.flatMap(planMigration(before, after), encodeMigration));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (value TEXT); INSERT INTO t VALUES ('21')");
    db.exec(sql);
    assert.equal(db.prepare("SELECT age FROM t").get()!.age, 21);
    assert.throws(() => db.exec("INSERT INTO t(value) VALUES ('10')"), /CHECK/);
  } finally {
    db.close();
  }
});
