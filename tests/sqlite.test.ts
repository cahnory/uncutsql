import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { type SourceNode, EncodeError, ParseError, document } from "../src/codec/index.ts";
import { type CreateTable, createTable, identifier, literalValue, stringLiteral } from "../src/sqlite/index.ts";
import { trivia } from "../src/sqlite/tokens.ts";

const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};

for (const filename of readdirSync(new URL("./fixtures/create-table/valid/", import.meta.url))) {
  test(`previous implementation fixture: ${filename}`, () => {
    const source = readFileSync(new URL(`./fixtures/create-table/valid/${filename}`, import.meta.url), "utf8");
    const ast = Effect.runSync(createTable.decode(source));
    const canonical = Effect.runSync(createTable.encode(ast));
    assert.deepEqual(Effect.runSync(createTable.decode(canonical)), ast);
    const before = new DatabaseSync(":memory:");
    const after = new DatabaseSync(":memory:");
    try {
      before.exec(source);
      after.exec(canonical);
      const table = '"' + ast.name.replaceAll('"', '""') + '"';
      assert.deepEqual(after.prepare(`PRAGMA table_info(${table})`).all(), before.prepare(`PRAGMA table_info(${table})`).all());
    } finally {
      before.close();
      after.close();
    }
  });
}

for (const filename of readdirSync(new URL("./fixtures/create-table/invalid/", import.meta.url))) {
  test(`rejects previous implementation fixture: ${filename}`, () => {
    const source = readFileSync(new URL(`./fixtures/create-table/invalid/${filename}`, import.meta.url), "utf8");
    assert.ok(failure(createTable.decode(source)) instanceof ParseError);
  });
}

test("canonical output normalizes casing, aliases, quoting, comments and terminator", () => {
  const ast = Effect.runSync(createTable.decode(`
    -- header
    create /* middle */ temp table if not exists [users] (
      id integer primary key,
      name text not null default 'O''Brien',
      note DEFAULT NULL
    ) -- optional semicolon
  `));
  assert.equal(Effect.runSync(createTable.encode(ast)),
    'CREATE TEMPORARY TABLE IF NOT EXISTS "users" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL DEFAULT \'O\'\'Brien\', "note" DEFAULT NULL);');
  assert.deepEqual(ast.columns[1]!.constraints, [
    { _tag: "NotNull" },
    { _tag: "Default", value: { _tag: "StringLiteral", value: "O'Brien" } },
  ]);
});

test("generated ASTs need no source metadata and defaults execute correctly in SQLite", () => {
  const ast: CreateTable = {
    _tag: "CreateTable", name: "people", temporary: false, ifNotExists: false,
    columns: [
      { name: "id", typeName: "INTEGER", constraints: [{ _tag: "PrimaryKey" }] },
      { name: "name", typeName: "TEXT", constraints: [
        { _tag: "Default", value: { _tag: "StringLiteral", value: "O'Brien" } },
        { _tag: "NotNull" }, { _tag: "Unique" },
      ] },
    ],
  };
  const sql = Effect.runSync(createTable.encode(ast));
  assert.deepEqual(Effect.runSync(createTable.decode(sql)), ast);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(sql);
    database.exec('INSERT INTO "people" DEFAULT VALUES');
    assert.equal(database.prepare('SELECT name FROM "people"').get()!.name, "O'Brien");
  } finally { database.close(); }
});

test("source map is separate, nested, excludes leading trivia and retains exact token slices", () => {
  const source = '  CREATE TABLE [users] ( id INTEGER, "name" TEXT ); -- tail';
  const parsed = Effect.runSync(createTable.decodeWithSourceMap(source));
  assert.equal(parsed.source, source);
  const flatten = (nodes: readonly SourceNode[]): readonly SourceNode[] =>
    nodes.flatMap((node) => [node, ...flatten(node.children)]);
  const nodes = flatten(parsed.sourceMap);
  assert.deepEqual(nodes.filter((node) => node.kind === "Identifier").map((node) =>
    source.slice(node.start, node.end)), ["[users]", "id", '"name"']);
  assert.equal(parsed.sourceMap[0]!.start, 2);
  assert.equal(source.slice(parsed.sourceMap[0]!.start, parsed.sourceMap[0]!.end),
    'CREATE TABLE [users] ( id INTEGER, "name" TEXT );');
  assert.equal("sourceMap" in parsed.value, false);
  assert.doesNotThrow(() => JSON.stringify(parsed.value));
});

test("string literals round-trip escaped quotes, whitespace, Unicode and SQL-looking text", () => {
  const codec = document(stringLiteral, trivia);
  const values = ["", "'", "''", "O'Brien", "line\r\nnext", "é漢字🐈", "'); DROP TABLE users; --", '"`[]'];
  const database = new DatabaseSync(":memory:");
  try {
    for (const value of values) {
      const ast = { _tag: "StringLiteral" as const, value };
      const sql = Effect.runSync(codec.encode(ast));
      assert.deepEqual(Effect.runSync(codec.decode(sql)), ast);
      assert.equal(database.prepare(`SELECT ${sql} AS value`).get()!.value, value);
    }
  } finally { database.close(); }
});

test("identifier quote styles normalize to escaped double quotes", () => {
  const codec = document(identifier, trivia);
  for (const source of ['"a""b"', '`a"b`', '[a"b]']) {
    assert.equal(Effect.runSync(codec.decode(source)), 'a"b');
  }
  for (const name of ["", "select", 'a"b', "O'Brien", "é漢字", "a.b", "a]b`c"]) {
    const sql = Effect.runSync(codec.encode(name));
    assert.equal(Effect.runSync(codec.decode(sql)), name);
  }
  assert.ok(failure(codec.decode("SELECT")) instanceof ParseError);
});

test("unterminated strings are committed at EOF with useful line/column diagnostics", () => {
  const sql = "CREATE TABLE t (\n  name TEXT DEFAULT 'unfinished";
  const error = failure(createTable.decode(sql));
  assert.equal(error.offset, sql.length);
  assert.equal(error.line, 2);
  assert.equal(error.column, 32);
  assert.equal(error.committed, true);
  assert.deepEqual(error.expected, ["closing '"]);
});

test("NULL and strings use the same bidirectional union", () => {
  const codec = document(literalValue, trivia);
  assert.deepEqual(Effect.runSync(codec.decode("null")), { _tag: "NullLiteral" });
  assert.equal(Effect.runSync(codec.encode({ _tag: "NullLiteral" })), "NULL");
});

test("encoding rejects empty column lists and unrepresentable NUL characters", () => {
  const empty: CreateTable = { _tag: "CreateTable", name: "t", temporary: false, ifNotExists: false, columns: [] };
  assert.ok(failure(createTable.encode(empty)) instanceof EncodeError);
  assert.ok(failure(identifier.encode("a\0b")) instanceof EncodeError);
  assert.ok(failure(stringLiteral.encode({ _tag: "StringLiteral", value: "a\0b" })) instanceof EncodeError);
});

for (const source of [
  "CREATE TABLE t (id INTEGER,)",
  "CREATE TABLE t (id INTEGER PRIMARY)",
  "CREATE TABLE t (id INTEGER NOT)",
  "CREATE TABLE t (id TEXT DEFAULT)",
  "CREATE TABLE t (id TEXT DEFAULT NULLx)",
  "CREATE TABLE t (id INTEGER) garbage",
  "CREATE TABLE t (id INTEGER); CREATE TABLE u (id INTEGER)",
  "CREATE TABLE t (id INTEGER);;",
  "CREATE TABLE t (id TEXT DEFAULT 42)",
  "CREATE TABLE t (id VARCHAR(20))",
  "CREATE TABLE t (id INTEGER) STRICT",
  "CREATE TABLEX t (id INTEGER)",
  "CREATE TABLE t ([unterminated INTEGER)",
]) {
  test(`rejects malformed or unsupported SQL: ${source}`, () => {
    assert.ok(failure(createTable.decode(source)) instanceof ParseError);
  });
}
