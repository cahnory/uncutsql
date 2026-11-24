import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { sqlQuery } from "../src/index.ts";
import type { CompoundQuery, QueryCore } from "../src/index.ts";
const decode = (sql: string) => Effect.runSync(sqlQuery.decode(sql));

test("compound queries preserve SQLite set operations, grouping and global tails", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "SELECT 1 AS v UNION SELECT 1",
      "SELECT 1 AS v UNION ALL SELECT 1",
      "SELECT 1 AS v UNION SELECT 2 INTERSECT SELECT 2",
      "SELECT 1 AS v UNION SELECT 2 EXCEPT SELECT 1",
      "SELECT NULL AS v UNION SELECT NULL",
      "VALUES (1),(2) UNION ALL SELECT 3 ORDER BY 1 DESC LIMIT 2",
      "SELECT 1 AS v UNION ALL VALUES (2),(3)",
      "SELECT 1 AS v UNION SELECT 3 UNION SELECT 2 ORDER BY v DESC LIMIT 1 OFFSET 1",
      "SELECT 1 AS v UNION ALL SELECT 2 UNION ALL SELECT 3 LIMIT ?, ?",
    ]) {
      const value = decode(source);
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(decode(rendered), value);
      const params = source.includes("?") ? [1, 2] : [];
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

test("compound syntax and constructed trees reject misplaced tails", () => {
  for (const source of [
    "SELECT 1 UNION",
    "SELECT 1 UNION ALL",
    "SELECT 1 INTERSECT ALL SELECT 1",
    "SELECT 1 ORDER BY 1 UNION SELECT 2",
    "SELECT 1 LIMIT 1 UNION SELECT 2",
    "SELECT 1 UNION VALUES (2) LIMIT 1",
    "VALUES (1) UNION VALUES (2) ORDER BY 1",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
  const head = decode("SELECT 1") as QueryCore;
  const base: CompoundQuery = {
    _tag: "CompoundQuery",
    head,
    rest: [{ operator: "UNION", query: head }],
  };
  for (const value of [
    { ...base, rest: [] },
    { ...base, head: decode("SELECT 1 LIMIT 2") as QueryCore },
    {
      ...base,
      orderBy: [{ expression: { _tag: "NumericLiteral" as const, value: "1" } }],
      rest: [{ operator: "UNION" as const, query: decode("VALUES (1)") as QueryCore }],
    },
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.encode(value)))));
  }
});

const root = new URL("./fixtures/previous/select-statement/", import.meta.url);
for (const category of readdirSync(root)) {
  for (const file of readdirSync(new URL(category + "/", root))) {
    test(`previous select-statement/${category}/${file}`, () => {
      const source = readFileSync(new URL(category + "/" + file, root), "utf8");
      const result = Effect.runSync(Effect.result(sqlQuery.decode(source)));
      if (category === "invalid") {
        assert.ok(Result.isFailure(result));
      } else {
        assert.ok(Result.isSuccess(result));
        assert.deepEqual(decode(Effect.runSync(sqlQuery.encode(result.success))), result.success);
      }
    });
  }
}
