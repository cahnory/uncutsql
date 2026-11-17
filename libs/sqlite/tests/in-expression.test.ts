import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { EncodeError, ParseError } from "@uncutsql/codec";
import { createTable, sqlExpression, type Expression, type InExpression } from "../src/index.ts";
import { binaryPrecedence } from "../src/codecs/expression/operators.ts";
import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";

const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (value: Expression) => Effect.runSync(sqlExpression.encode(value));

test("IN lists preserve SQLite precedence, nesting, empty lists and NULL behavior", () => {
  const database = new DatabaseSync(":memory:");
  const sources = [
    "2 IN (1, 2, 3)",
    "2 NOT IN (1, 3)",
    "NULL IN ()",
    "NULL NOT IN ()",
    "2 IN ()",
    "2 NOT IN ()",
    "2 IN (NULL, 3)",
    "2 NOT IN (NULL, 3)",
    "2 IN (NULL, 2)",
    "NULL IN (1, 2)",
    "NULL NOT IN (1, 2)",
    "NOT 2 IN (1, 2)",
    "2 NOT /* comment */ IN (abs(-2), 1 + 3)",
    "2 IN (1 IN (0, 1), 2)",
    "(0 OR 2) IN (1, 2)",
    "2 IN (0 OR 2, 2 AND 3)",
    "2 IN (1, 2) BETWEEN 0 AND 1",
    "2 BETWEEN 0 AND 3 IN (1)",
    "2 BETWEEN 0 IN (0) AND 3",
    "2 IN (1, 2) IN (0, 1)",
    "2 ISNULL IN (0)",
    "2 IN (1, 2) ISNULL",
  ];
  for (const operator of Object.keys(binaryPrecedence)) {
    sources.push(`2 ${operator} 1 IN (0, 1)`, `2 IN (0, 1) ${operator} 1`);
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

test("IN retains its semantic tree and nested source spans", () => {
  const source = "a NOT IN (1, abs(-2))";
  const parsed = Effect.runSync(sqlExpression.decodeWithSourceMap(source));
  assert.deepEqual(parsed.value, {
    _tag: "InExpression",
    operator: "NOT IN",
    operand: { _tag: "ColumnReference", parts: ["a"] },
    values: [
      { _tag: "NumericLiteral", value: "1" },
      {
        _tag: "FunctionCall",
        name: "abs",
        arguments: [
          {
            _tag: "UnaryExpression",
            operator: "-",
            operand: { _tag: "NumericLiteral", value: "2" },
          },
        ],
      },
    ],
  });
  const span = parsed.sourceMap.find((node) => node.kind === "InExpression");
  assert.ok(span);
  assert.equal(source.slice(span.start, span.end), source);
  assert.ok(span.children.some((node) => node.kind === "FunctionCall"));
});

test("malformed and unsupported IN targets fail with committed errors", () => {
  for (const source of [
    "1 IN",
    "1 NOT IN",
    "1 IN (",
    "1 IN (1,)",
    "1 IN (,1)",
    "1 IN (1 2)",
    "1 IN (SELECT 1)",
    "1 IN t",
    "1 IN f()",
    "1 IN ((1, 2))",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError, source);
    assert.equal(result.failure.committed, true, source);
  }
});

test("IN works in defaults, checks and generated columns", () => {
  const source = `CREATE TABLE t (
    a INTEGER DEFAULT (2 IN (1, 2)) CHECK (a IN (0, 1)),
    b INTEGER GENERATED ALWAYS AS (a NOT IN (0)) STORED
  )`;
  const ast = Effect.runSync(createTable.decode(source));
  const sql = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
  for (const statement of [source, sql]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(statement);
      database.exec("INSERT INTO t DEFAULT VALUES");
      assert.deepEqual({ ...database.prepare("SELECT a, b FROM t").get() }, { a: 1, b: 1 });
      assert.throws(() => database.exec("INSERT INTO t (a) VALUES (2)"), /CHECK/);
    } finally {
      database.close();
    }
  }
});

test("IN default validation visits the operand and every list item", () => {
  for (const source of ["a IN ()", "0 IN (a)", "0 IN (1, abs(a))"]) {
    const value = decode(source);
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(defaultColumnConstraint.encode({ _tag: "Default", value }))),
      ),
    );
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(createTable.decode(`CREATE TABLE t (a DEFAULT (${source}))`))),
      ),
    );
  }
});

test("IN encoder rejects invalid operators and list payloads", () => {
  const value: InExpression = {
    _tag: "InExpression",
    operator: "IN",
    operand: decode("1"),
    values: [],
  };
  for (const invalid of [
    { ...value, operator: "INVALID" } as unknown as InExpression,
    { ...value, values: undefined } as unknown as InExpression,
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.encode(invalid)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof EncodeError);
  }
});
