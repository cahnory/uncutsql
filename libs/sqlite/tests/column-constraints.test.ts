import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";

import { createTable } from "../src/index.ts";
import type { CreateTable } from "../src/index.ts";

const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};

test("expression defaults and CHECK constraints retain SQLite behavior", () => {
  const source = `CREATE TABLE t (
    a INTEGER DEFAULT (1 + 2*3) CHECK (a - (b - c) > 0),
    b INTEGER DEFAULT -4,
    c INTEGER DEFAULT +2,
    data BLOB DEFAULT X'00FF'
  )`;
  const ast = Effect.runSync(createTable.decode(source));
  const canonical = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(canonical)), ast);
  assert.match(canonical, /DEFAULT \(1 \+ 2 \* 3\)/);
  assert.match(canonical, /CHECK \("a" - \("b" - "c"\) > 0\)/);

  for (const sql of [source, canonical]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec("INSERT INTO t DEFAULT VALUES");
      const row = database.prepare("SELECT * FROM t").get()!;
      assert.deepEqual({ ...row }, { a: 7, b: -4, c: 2, data: new Uint8Array([0, 255]) });
      database.exec("INSERT INTO t (a,b,c) VALUES (4,3,2)");
      database.exec("INSERT INTO t (a,b,c) VALUES (NULL,3,2)");
      assert.throws(
        () => database.exec("INSERT INTO t (a,b,c) VALUES (0,4,2)"),
        /CHECK constraint failed/,
      );
    } finally {
      database.close();
    }
  }
});

test("literal and signed defaults remain unparenthesized; general expressions are grouped", () => {
  for (const [source, expected] of [
    ["42", "42"],
    ["-42", "-42"],
    ["+ .5", "+.5"],
    ["0xFF", "0xFF"],
    ["X'00ff'", "X'00ff'"],
    ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP"],
    ["TRUE", "TRUE"],
    ["((1))", "1"],
    ["(NOT 0)", "(NOT 0)"],
    ["(- -1)", "(- -1)"],
    ["(1 + 2 * 3)", "(1 + 2 * 3)"],
  ]) {
    const ast = Effect.runSync(createTable.decode(`CREATE TABLE t (a DEFAULT ${source})`));
    const sql = Effect.runSync(createTable.encode(ast));
    assert.equal(sql, `CREATE TABLE "t" ("a" DEFAULT ${expected});`);
    assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec("INSERT INTO t DEFAULT VALUES");
    } finally {
      database.close();
    }
  }
});

test("constraint order is retained as DEFAULT and CHECK are composed with other rules", () => {
  const ast = Effect.runSync(
    createTable.decode("CREATE TABLE t (a INTEGER DEFAULT (1 + 2) NOT NULL CHECK (a > 0) UNIQUE)"),
  );
  assert.deepEqual(
    ast.columns[0]!.constraints.map((constraint) => constraint._tag),
    ["Default", "NotNull", "Check", "Unique"],
  );
  assert.deepEqual(
    Effect.runSync(createTable.decode(Effect.runSync(createTable.encode(ast)))),
    ast,
  );
});

for (const source of [
  "CREATE TABLE t (a DEFAULT 1 + 2)",
  "CREATE TABLE t (a DEFAULT -'text')",
  "CREATE TABLE t (a DEFAULT NOT 0)",
  "CREATE TABLE t (a DEFAULT (other))",
  "CREATE TABLE t (a DEFAULT (1 + other))",
  "CREATE TABLE t (a DEFAULT (other NOT NULL))",
  "CREATE TABLE t (a DEFAULT (1 +))",
  "CREATE TABLE t (a DEFAULT ())",
  "CREATE TABLE t (a DEFAULT (?1))",
  "CREATE TABLE t (a DEFAULT ((SELECT 1)))",
  "CREATE TABLE t (a CHECK a > 0)",
  "CREATE TABLE t (a CHECK ())",
  "CREATE TABLE t (a CHECK (a >))",
]) {
  test(`rejects invalid DEFAULT/CHECK syntax: ${source}`, () => {
    assert.ok(failure(createTable.decode(source)) instanceof ParseError);
  });
}

test("generated default expressions reject column references through EncodeError", () => {
  const ast: CreateTable = {
    _tag: "CreateTable",
    columns: [
      {
        constraints: [
          {
            _tag: "Default",
            value: {
              _tag: "BinaryExpression",
              left: { _tag: "NumericLiteral", value: "1" },
              operator: "+",
              right: { _tag: "ColumnReference", parts: ["other"] },
            },
          },
        ],
        name: "a",
        typeName: undefined,
      },
    ],
    ifNotExists: false,
    name: "t",
    tableConstraints: [],
    temporary: false,
  };
  assert.ok(failure(createTable.encode(ast)) instanceof EncodeError);
});
