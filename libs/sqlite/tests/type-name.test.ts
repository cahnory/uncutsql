import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { document, EncodeError, ParseError } from "@uncutsql/codec";

import { columnType, createTable } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";

const codec = document(columnType);
const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};

for (const type of [
  "INT",
  "ANY",
  "integer",
  "DOUBLE PRECISION",
  "UNSIGNED BIG INT",
  "NATIVE CHARACTER(10)",
  "VARYING CHARACTER ( 10 )",
  "VARCHAR(255)",
  "NUMERIC(+10, -2)",
  "FLOAT(1.5)",
  "NUMERIC(1e2,2)",
  "VARCHAR(0x10)",
  "foo",
  '"my type"',
  '"DOUBLE" "PRECISION"',
  'DOUBLE "PRECISION"',
  "'Select'",
  "'double precision'",
  "'owner''s' 'Select'(+10, -2)",
  "Replace 'TEXT' (1e2, 2)",
  "MY /* INT */ TYPE",
  "CUSTOM(1 /* INT */)",
  "CUSTOM -- INT\n TYPE",
]) {
  test(`type spelling and SQLite declaration survive: ${type}`, () => {
    assert.equal(Effect.runSync(codec.decode(type)), type);
    assert.equal(Effect.runSync(codec.encode(type)), type);
    const source = `CREATE TABLE t (a ${type})`;
    const ast = Effect.runSync(createTable.decode(source));
    assert.equal(ast.columns[0]!.typeName, type);
    const encoded = Effect.runSync(createTable.encode(ast));
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(source);
      const before = database.prepare("PRAGMA table_xinfo(t)").all();
      database.exec("DROP TABLE t");
      database.exec(encoded);
      assert.deepEqual(database.prepare("PRAGMA table_xinfo(t)").all(), before);
    } finally {
      database.close();
    }
  });
}

test("bare keyword type words match SQLite in the first and subsequent positions", () => {
  using database = new DatabaseSync(":memory:");
  for (const word of keywords) {
    const token = word[0] + word.slice(1).toLowerCase();
    for (const type of [token, `CUSTOM ${token}`]) {
      // Disambiguate keywords that would otherwise form complete constraints.
      const declaration = ["DEFERRABLE", "NULL", "UNIQUE"].includes(word) ? `${type}(2)` : type;
      const source = `CREATE TABLE t (a ${declaration})`;
      const parsed = Effect.runSync(Effect.result(createTable.decode(source)));
      try {
        database.exec(source);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.match(error.message, /syntax error/, source);
        assert.ok(Result.isFailure(parsed), source);
        continue;
      }
      assert.ok(Result.isSuccess(parsed), source);
      assert.equal(parsed.success.columns[0]!.typeName, declaration);
      const metadata = () => database.prepare("SELECT * FROM pragma_table_xinfo('t')").all();
      const before = metadata();
      database.exec("DROP TABLE t");
      database.exec(Effect.runSync(createTable.encode(parsed.success)));
      assert.deepEqual(metadata(), before, source);
      database.exec("DROP TABLE t");
    }
  }
});

test("GENERATED ALWAYS AS ends a column type and preserves generated metadata", () => {
  const source = `CREATE TABLE t (
    seed INT,
    a Replace Generated Always AS (seed + 1) STORED,
    b Generated Always /* before AS */ AS (seed + 2),
    c 'Select' 'TEXT'(+10, -2) GENERATED /* after dimensions */ ALWAYS AS (seed + 3) VIRTUAL,
    d Generated AS (seed + 4),
    e Custom Generated Always (2) AS (seed + 5)
  )`;
  const ast = Effect.runSync(createTable.decode(source));
  assert.deepEqual(
    ast.columns.map(({ typeName }) => typeName),
    [
      "INT",
      "Replace",
      undefined,
      "'Select' 'TEXT'(+10, -2)",
      "Generated",
      "Custom Generated Always (2)",
    ],
  );
  const formatted = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(formatted)), ast);
  using database = new DatabaseSync(":memory:");
  const metadata = () => database.prepare("SELECT * FROM pragma_table_xinfo('t')").all();
  database.exec(source);
  const before = metadata();
  assert.deepEqual(
    before.map(({ hidden }) => hidden),
    [0, 3, 2, 2, 2, 2],
  );
  database.exec("DROP TABLE t");
  database.exec(formatted);
  assert.deepEqual(metadata(), before);
});

test("comments inside type declarations can affect affinity and must survive encoding", () => {
  const type = "CUSTOM /* INT */ TYPE";
  const encoded = Effect.runSync(codec.encode(Effect.runSync(codec.decode(type))));
  const database = new DatabaseSync(":memory:");
  try {
    const row = database
      .prepare(
        `SELECT typeof(CAST(4.5 AS ${encoded})) AS kept, typeof(CAST(4.5 AS CUSTOM TYPE)) AS stripped`,
      )
      .get()!;
    assert.deepEqual({ ...row }, { kept: "integer", stripped: "real" });
  } finally {
    database.close();
  }
});

test("type parsing stops before each column-constraint prefix", () => {
  const ast = Effect.runSync(
    createTable.decode(`CREATE TABLE t (
    a DOUBLE PRECISION CONSTRAINT positive CHECK (a > 0),
    b VARCHAR(20) COLLATE NOCASE UNIQUE ON CONFLICT IGNORE,
    c NUMERIC(10, 2) NOT NULL DEFAULT 0,
    d INT GENERATED ALWAYS AS (c + 1)
  )`),
  );
  assert.deepEqual(
    ast.columns.map((column) => column.typeName),
    ["DOUBLE PRECISION", "VARCHAR(20)", "NUMERIC(10, 2)", "INT"],
  );
  assert.deepEqual(
    ast.columns.map((column) => column.constraints.map((constraint) => constraint._tag)),
    [["Check"], ["Collate", "Unique"], ["NotNull", "Default"], ["Generated"]],
  );
});

for (const source of [
  "",
  "123",
  "SELECT",
  "TEXT()",
  "TEXT(1,)",
  "TEXT(1,2,3)",
  "TEXT(foo)",
  "TEXT(1+2)",
  "TEXT(1_0)",
  "TEXT(1",
  '"unterminated',
  "'unterminated",
]) {
  test(`reject invalid type declaration: ${source}`, () => {
    assert.ok(failure(codec.decode(source)) instanceof ParseError);
    assert.ok(failure(codec.encode(source)) instanceof EncodeError);
  });
}

test("a constructed type cannot inject constraints, delimiters or additional statements", () => {
  for (const source of [
    "INT PRIMARY KEY",
    "Replace GENERATED ALWAYS AS (1)",
    "'TEXT' CHECK (1)",
    "INT) STRICT; DROP TABLE t; --",
    "INT, other TEXT",
    " INT",
    "INT -- trailing comment",
  ]) {
    assert.ok(failure(codec.encode(source)) instanceof EncodeError);
  }
});
