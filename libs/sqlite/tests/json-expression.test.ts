import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { ParseError } from "@uncutsql/codec";

import { encodeMigration, schema, sqlExpression } from "../src/index.ts";
import type { Expression } from "../src/index.ts";
import { planMigration } from "./workflow.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (ast: Expression) => Effect.runSync(sqlExpression.encode(ast));

test("previous JSON arrow edge fixture and nested paths round-trip", () => {
  const source = readFileSync(
    new URL("./fixtures/expression/02_json_arrow.sql", import.meta.url),
    "utf8",
  );
  assert.deepEqual(decode(source), {
    _tag: "BinaryExpression",
    left: { _tag: "ColumnReference", parts: ["a"] },
    operator: "->",
    right: { _tag: "StringLiteral", value: "$.x" },
  });
  for (const sql of [
    "a->'x'->>0",
    "a -> ('x' || 'y')",
    "(a || a) ->> 'x'",
    "a ->> (b ->> 'path')",
    "a ->> -1",
    "a-> /* path */ 'x' COLLATE NOCASE",
  ]) {
    const ast = decode(sql);
    assert.deepEqual(decode(encode(ast)), ast);
  }
  assert.equal(encode(decode("a -> ('x' || 'y')")), `"a" -> ('x' || 'y')`);
  assert.equal(encode(decode("a ->> (b ->> 'path')")), `"a" ->> ("b" ->> 'path')`);
});

test("JSON arrows preserve JSON text versus SQL values and NULL behavior", () => {
  const db = new DatabaseSync(":memory:");
  const examples: readonly [string, unknown, string][] = [
    [`'{"a":"xyz"}' -> 'a'`, '"xyz"', "text"],
    [`'{"a":"xyz"}' ->> 'a'`, "xyz", "text"],
    [`'{"a":2}' -> 'a'`, "2", "text"],
    [`'{"a":2}' ->> 'a'`, 2, "integer"],
    [`'{"a":2.5}' ->> 'a'`, 2.5, "real"],
    [`'{"a":null}' -> 'a'`, "null", "text"],
    [`'{"a":null}' ->> 'a'`, null, "null"],
    [`'{}' -> 'missing'`, null, "null"],
    [`'{}' ->> 'missing'`, null, "null"],
    [`'{"a":true}' ->> 'a'`, 1, "integer"],
    [`'{"a":[1,2]}' ->> 'a'`, "[1,2]", "text"],
    [`'[11,22,33]' ->> -1`, 33, "integer"],
    [`'[11,22,33]' -> '$[#-1]'`, "33", "text"],
    [`'{"a":[{"b":7}]}' -> 'a' -> 0 ->> 'b'`, 7, "integer"],
    [`jsonb('{"a":7}') ->> '$.a'`, 7, "integer"],
    [`NULL ->> 'a'`, null, "null"],
    [`'{}' -> '$['`, null, "null"],
  ];
  try {
    for (const [source, value, type] of examples) {
      const ast = decode(source);
      const printed = encode(ast);
      assert.deepEqual(decode(printed), ast);
      for (const sql of [source, printed]) {
        const row = db.prepare(`SELECT (${sql}) AS value, typeof(${sql}) AS type`).get()!;
        assert.equal(row.value, value, source);
        assert.equal(row.type, type, source);
      }
    }
    for (const source of [
      `'{"a":2}' ->> 'a' + 3 * 4`,
      `'{"a":2}' ->> 'a' || '3'`,
      `'{"a":' || '2}' ->> 'a'`,
      `'{"a":"ADA"}' ->> 'a' COLLATE NOCASE = 'ada'`,
      `NOT '{"a":false}' ->> 'a'`,
      `json_array('[1,2]' -> '$')`,
      `json_array('[1,2]' ->> '$')`,
    ]) {
      assert.deepEqual(
        db.prepare(`SELECT ${encode(decode(source))} AS value`).get(),
        db.prepare(`SELECT ${source} AS value`).get(),
        source,
      );
    }
  } finally {
    db.close();
  }
});

test("arrows are complete tokens and missing operands produce committed parse errors", () => {
  for (const source of ["a ->", "a ->>", "a -> > b", "a ->>> b", "a - > b"]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof ParseError);
    assert.equal(result.failure.committed, true);
  }
  for (const source of ["'bad json' -> 'x'", "'[1]' -> '$['"]) {
    const ast = decode(source);
    const db = new DatabaseSync(":memory:");
    try {
      assert.throws(() => db.prepare(`SELECT ${encode(ast)}`).get());
    } finally {
      db.close();
    }
  }
});

test("JSON expressions survive defaults, generated columns, checks and a rebuild migration", () => {
  const before = Effect.runSync(schema.decode("CREATE TABLE t (payload TEXT)"));
  const after = Effect.runSync(
    schema.decode(`CREATE TABLE t (
    payload TEXT CHECK (payload ->> 'age' >= 18),
    age INTEGER AS (payload ->> 'age') STORED,
    label TEXT DEFAULT ('{"label":"unknown"}' ->> 'label')
  )`),
  );
  const sql = Effect.runSync(Effect.flatMap(planMigration(before, after), encodeMigration));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE t (payload TEXT); INSERT INTO t VALUES ('{"age":21}')`);
    db.exec(sql);
    assert.deepEqual(
      { ...db.prepare("SELECT age, label FROM t").get() },
      { age: 21, label: "unknown" },
    );
    assert.throws(() => db.exec(`INSERT INTO t(payload) VALUES ('{"age":10}')`), /CHECK/);
    assert.equal(
      Effect.runSync(schema.decode(Effect.runSync(schema.encode(after))))[0]!._tag,
      "CreateTable",
    );
  } finally {
    db.close();
  }
});
