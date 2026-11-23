import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { EncodeError, ParseError } from "@uncutsql/codec";
import { sqlExpression, createTable, type Expression } from "../src/index.ts";
import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (value: Expression) => Effect.runSync(sqlExpression.encode(value));

test("parenthesized scalar groups and row values remain distinct", () => {
  assert.deepEqual(decode("((1))"), { _tag: "NumericLiteral", value: "1" });
  assert.deepEqual(decode("(1, 2)"), {
    _tag: "RowValueExpression",
    values: [
      { _tag: "NumericLiteral", value: "1" },
      { _tag: "NumericLiteral", value: "2" },
    ],
  });
  for (const source of [
    "(a, b)",
    "((a,b))",
    "(CASE WHEN 1 THEN 2 END, CAST(3 AS TEXT))",
    "((a,b),c)",
    "(?, :x)",
  ]) {
    const value = decode(source);
    assert.deepEqual(decode(encode(value)), value);
  }
});

test("row comparisons, NULL ordering, membership and BETWEEN match SQLite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "(1,2) = (1,2)",
      "(1,2) != (1,3)",
      "(1,2) < (1,3)",
      "(1,2) >= (0,9)",
      "(1,NULL) = (1,NULL)",
      "(1,NULL) IS (1,NULL)",
      "(1,NULL) IS NOT (1,NULL)",
      "(1,NULL,3) < (2,0,0)",
      "(1,NULL,3) < (1,0,0)",
      "(2,3) BETWEEN (1,9) AND (3,0)",
      "(2,3) NOT BETWEEN (1,9) AND (3,0)",
      "(1,2) IN ((1,2),(3,4))",
      "(1,2) NOT IN ((1,3),(3,4))",
      "('ADA' COLLATE NOCASE, 1) = ('ada', 1)",
      "NOT (1,2) = (1,3)",
      "(1,2) = (1,2) AND 1",
    ]) {
      const value = decode(source);
      const sql = encode(value);
      assert.deepEqual(decode(sql), value);
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

test("row-value codec requires at least two items and rejects malformed lists", () => {
  for (const values of [[], [{ _tag: "NullLiteral" as const }]]) {
    const result = Effect.runSync(
      Effect.result(sqlExpression.encode({ _tag: "RowValueExpression", values })),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof EncodeError);
  }
  for (const source of ["()", "(1,)", "(,1)", "(1,,2)", "(1,2"]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof ParseError);
  }
});

test("row comparisons work in defaults and CHECK while nested column defaults fail", () => {
  const ast = Effect.runSync(
    createTable.decode("CREATE TABLE t (a DEFAULT ((1,2) = (1,2)), b, CHECK ((a,b) > (0,0)))"),
  );
  const sql = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    db.exec("INSERT INTO t(b) VALUES (2)");
    assert.equal(db.prepare("SELECT a FROM t").get()!.a, 1);
    assert.throws(() => db.exec("INSERT INTO t VALUES (0,0)"), /CHECK/);
  } finally {
    db.close();
  }
  const result = Effect.runSync(
    Effect.result(
      defaultColumnConstraint.encode({ _tag: "Default", value: decode("(a,1) = (1,1)") }),
    ),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EncodeError);
});
