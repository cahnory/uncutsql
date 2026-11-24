import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { type SourceNode, ParseError } from "@uncutsql/codec";
import { schema } from "../src/index.ts";

const decode = (sql: string) => Effect.runSync(schema.decode(sql));
const encode = (sql: string) => Effect.runSync(schema.encode(decode(sql)));

test("schema files retain table order and SQLite metadata across encoding", () => {
  const source = `-- Semicolons inside literals and comments are not separators.
    CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT DEFAULT ';');
    /* ; */ CREATE TABLE child (id, parent_id REFERENCES parent(id), CHECK (id IN (1, 2)))`;
  const sql = encode(source);
  assert.deepEqual(decode(sql), decode(source));
  assert.deepEqual(
    decode(sql).map((table) => table.name),
    ["parent", "child"],
  );
  const snapshots = [source, sql].map((text) => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(text);
      return [
        database.prepare("PRAGMA table_info(parent)").all(),
        database.prepare("PRAGMA foreign_key_list(child)").all(),
      ];
    } finally {
      database.close();
    }
  });
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test("empty schemas, empty statements and optional final terminators", () => {
  for (const source of ["", " -- comment", "; ; /* ; */ ;"]) {
    assert.deepEqual(decode(source), []);
    assert.equal(encode(source), "");
  }
  for (const source of ["CREATE TABLE t (a)", "; CREATE TABLE t (a); ; -- end"]) {
    assert.equal(encode(source), 'CREATE TABLE "t" ("a");');
  }
});

test("schema files require separators and reject unsupported trailing statements", () => {
  for (const source of [
    "CREATE TABLE a (x) CREATE TABLE b (x)",
    "CREATE TABLE a (x); SELECT 1;",
    "CREATE INDEX idx ON a();",
    "CREATE TABLE a (x); garbage",
  ]) {
    const result = Effect.runSync(Effect.result(schema.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
  }
});

test("schema errors and source maps retain original file positions", () => {
  const source = "CREATE TABLE a (x);\r\nCREATE TABLE b (y DEFAULT );";
  const result = Effect.runSync(Effect.result(schema.decode(source)));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.line, 2);
  assert.equal(result.failure.offset, source.indexOf(")", source.indexOf("DEFAULT")));
  const valid = "-- header\nCREATE TABLE a (x);\nCREATE TABLE b (y);";
  const parsed = Effect.runSync(schema.decodeWithSourceMap(valid));
  assert.deepEqual(
    parsed.sourceMap.map((node) => valid.slice(node.start, node.end)),
    ["CREATE TABLE a (x);", "CREATE TABLE b (y);"],
  );
  const flatten = (nodes: readonly SourceNode[]): readonly SourceNode[] =>
    nodes.flatMap((node) => [node, ...flatten(node.children)]);
  assert.ok(
    flatten(parsed.sourceMap[1]!.children).some(
      (node) => node.kind === "Identifier" && valid.slice(node.start, node.end) === "b",
    ),
  );
});
