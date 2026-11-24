import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";

import { defaultColumnConstraint } from "../src/codecs/column-constraint/default-column-constraint.ts";
import { createTable, sqlExpression } from "../src/index.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (sql: string) => Effect.runSync(sqlExpression.encode(decode(sql)));

test("binding tokens retain exact spelling including namespace/suffix extensions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const value of [
      "?",
      "?1",
      "?001",
      ":name",
      "@name",
      "$name",
      ":123",
      "$名",
      "$ns::name(key)",
      "@ns::name(key)",
      ":ns::name(key)",
      "$::name",
      "$name::",
    ]) {
      assert.deepEqual(decode(value), { _tag: "BindParameter", value });
      assert.equal(encode(value), value);
      const result = db.prepare(`SELECT ${value} AS value`).get();
      assert.equal(result!.value, null);
    }
    const source = "?1 + ?2 + ?1";
    const sql = encode(source);
    assert.equal(db.prepare(`SELECT ${sql} AS value`).get({ "?1": 3, "?2": 4 })!.value, 10);
    assert.equal(db.prepare(`SELECT ${encode("? + ? * ?")} AS value`).get(2, 3, 4)!.value, 14);
    const names = { ":x": 1, "@x": 2, "$ns::x(key)": 4, $x: 3 };
    const named = db.prepare(`SELECT ${encode(":x + @x + $x + $ns::x(key)")} AS value`);
    named.setAllowBareNamedParameters(false);
    assert.equal(named.get(names)!.value, 10);
  } finally {
    db.close();
  }
});

test("parameters compose with CASE, CAST, patterns and JSON without changing binding order", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "CASE WHEN :x THEN CAST(:y AS INTEGER) ELSE :z END",
      "?1 LIKE ?2 ESCAPE ?3",
      "?1 ->> ?2",
    ]) {
      const ast = decode(source);
      assert.deepEqual(decode(Effect.runSync(sqlExpression.encode(ast))), ast);
    }
    assert.equal(
      db.prepare(`SELECT ${encode("CAST(? AS INTEGER) + ?")} AS value`).get("12", 3)!.value,
      15,
    );
  } finally {
    db.close();
  }
});

test("malformed bindings and injected constructed spellings fail typed validation", () => {
  for (const source of [":", "@", "$", "$::", "$name(unclosed", "$name(with space)", "?1x"]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
  }
  for (const value of ["", "name", "?1 + 2", ":x; SELECT 1", "$x(unclosed", "$x(a\0b)"]) {
    const result = Effect.runSync(
      Effect.result(sqlExpression.encode({ _tag: "BindParameter", value })),
    );
    assert.ok(Result.isFailure(result), value);
    assert.ok(result.failure instanceof EncodeError);
  }
});

test("defaults reject bind parameters even inside unreachable branches", () => {
  for (const source of [
    "?",
    "CASE WHEN 1 THEN 2 ELSE :x END",
    "CAST(@x AS TEXT)",
    "'a' LIKE 'a' ESCAPE $x",
  ]) {
    const parsed = Effect.runSync(
      Effect.result(createTable.decode(`CREATE TABLE t (a DEFAULT (${source}))`)),
    );
    assert.ok(Result.isFailure(parsed));
    const encoded = Effect.runSync(
      Effect.result(defaultColumnConstraint.encode({ _tag: "Default", value: decode(source) })),
    );
    assert.ok(Result.isFailure(encoded));
    assert.ok(encoded.failure instanceof EncodeError);
  }
});
