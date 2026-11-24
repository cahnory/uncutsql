import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { sqlQuery } from "../src/index.ts";

test("derived tables compose with aliases, compounds and recursively nested queries", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "SELECT * FROM (SELECT 1 AS v)",
      "SELECT d.* FROM (VALUES (1),(2)) AS d",
      "SELECT d.v FROM (SELECT 2 AS v UNION ALL SELECT 1) d ORDER BY d.v",
      "SELECT d.v FROM (SELECT 1 AS v UNION SELECT 2 ORDER BY v DESC LIMIT 1) AS d",
      "SELECT d.v FROM (SELECT x.v FROM (SELECT 1 AS v) x) d",
      "SELECT a.v AS a, b.v AS b FROM (SELECT 1 AS v) a, (SELECT 2 AS v) b",
      "SELECT * FROM (SELECT (SELECT 1) AS v) WHERE v IN (SELECT 1)",
      "SELECT * FROM (SELECT ? AS v UNION ALL SELECT ?) AS d ORDER BY v LIMIT ?",
    ]) {
      const value = Effect.runSync(sqlQuery.decode(source));
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(Effect.runSync(sqlQuery.decode(rendered)), value);
      const params = source.includes("?") ? [3, 1, 2] : [];
      assert.deepEqual(
        db.prepare(rendered).all(...params),
        db.prepare(source).all(...params),
        source,
      );
    }
  } finally {
    db.close();
  }
});

test("derived tables reject incomplete queries and aliases", () => {
  for (const source of [
    "SELECT * FROM ()",
    "SELECT * FROM (SELECT)",
    "SELECT * FROM (SELECT 1",
    "SELECT * FROM (SELECT 1) AS",
    "SELECT * FROM (SELECT 1;) d",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
});

for (const file of ["04_subquery.sql", "05_subquery_alias.sql"]) {
  test(`previous table-or-subquery/${file}`, () => {
    const source =
      "SELECT * FROM " +
      readFileSync(
        new URL(`./fixtures/previous/table-or-subquery/valid/${file}`, import.meta.url),
        "utf8",
      );
    const value = Effect.runSync(sqlQuery.decode(source));
    assert.deepEqual(
      Effect.runSync(sqlQuery.decode(Effect.runSync(sqlQuery.encode(value)))),
      value,
    );
  });
}
