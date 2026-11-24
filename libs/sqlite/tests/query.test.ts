import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { sqlQuery } from "../src/index.ts";
import type { ValuesQuery } from "../src/index.ts";
const decode = (source: string) => Effect.runSync(sqlQuery.decode(source));

test("VALUES queries preserve rows, expression trees and native results", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "VALUES (1)",
      "VALUES (1,'a'), (2,NULL), (3,'b')",
      "VALUES (1 + 2 * 3, CASE WHEN 0 THEN 1 ELSE 2 END), (CAST('3' AS INTEGER), length('ab'))",
      "/*before*/ VALUES /*row*/ (1), --next\n (2); --end",
      readFileSync(new URL("./fixtures/previous/select-values/valid.sql", import.meta.url), "utf8"),
    ]) {
      const value = decode(source);
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(decode(rendered), value);
      assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all(), source);
    }
    const query = decode("VALUES (?1, :value), (?1 + 1, :value)");
    const rendered = Effect.runSync(sqlQuery.encode(query));
    assert.deepEqual(
      db.prepare(rendered).all({ ":value": "x", "?1": 4 }),
      db.prepare("VALUES (?1, :value), (?1 + 1, :value)").all({ ":value": "x", "?1": 4 }),
    );
  } finally {
    db.close();
  }
});

test("VALUES rejects incomplete rows, trailing clauses and empty constructed lists", () => {
  for (const source of [
    "VALUES",
    "VALUES ()",
    "VALUES (1),",
    "VALUES (1,)",
    "VALUES 1",
    "VALUES (1) ORDER BY 1",
    "VALUES (1) LIMIT 1",
    "VALUES (1); VALUES (2)",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
  for (const rows of [[], [[]]]) {
    const value: ValuesQuery = { _tag: "ValuesQuery", rows };
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.encode(value)))));
  }
});
