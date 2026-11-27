import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { sqlQuery } from "../src/index.ts";
import type { Query } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";

const decode = (sql: string) => Effect.runSync(sqlQuery.decode(sql));

test("WITH supports multiple, recursive, nested and materialized CTEs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of [
      "WITH x AS (SELECT 1 AS v) SELECT * FROM x",
      "WITH x(v) AS (VALUES(1),(2)), y AS (SELECT v+1 AS v FROM x) SELECT * FROM y ORDER BY v",
      "WITH x AS (SELECT 1) VALUES(2)",
      "WITH RECURSIVE x(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM x WHERE v<4) SELECT * FROM x",
      "WITH x(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM x WHERE v<3) SELECT * FROM x",
      "WITH x AS (WITH y AS (SELECT 3 AS v) SELECT v FROM y) SELECT v FROM x",
      "SELECT * FROM (WITH x AS (SELECT 1 AS v) SELECT v FROM x) d",
      "SELECT (WITH x AS (VALUES(1)) SELECT * FROM x) AS result",
      "WITH x AS MATERIALIZED (SELECT 1 AS v) SELECT * FROM x",
      "WITH x AS NOT MATERIALIZED (SELECT 1 AS v) SELECT * FROM x",
      "WITH x AS (SELECT 1 AS v) SELECT * FROM x UNION ALL SELECT 2 ORDER BY v DESC LIMIT 1",
      "WITH x(v) AS (VALUES(?)), y(v) AS (SELECT ? + v FROM x) SELECT v FROM y WHERE v > ?",
    ]) {
      const value = decode(source);
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(decode(rendered), value);
      const params = source.includes("?") ? [1, 2, 0] : [];
      assert.deepEqual(
        db.prepare(rendered).all(...params),
        db.prepare(source).all(...params),
        source,
      );
      assert.deepEqual(
        db.prepare(`EXPLAIN QUERY PLAN ${rendered}`).all(...params),
        db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params),
        source,
      );
    }
    assert.equal(
      decode("WITH x AS (SELECT 1) SELECT * FROM x").with!.expressions[0]!.materialization,
      undefined,
    );
  } finally {
    db.close();
  }
});

test("CTE names and declared columns match SQLite keyword and quoting rules", () => {
  using db = new DatabaseSync(":memory:");
  for (const name of [...keywords]
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .concat("owner's key")) {
    for (const token of [name, `'${name.replaceAll("'", "''")}'`]) {
      for (const source of [
        `WITH ${token} AS (SELECT 1 AS v) SELECT * FROM "${name}"`,
        `WITH RECURSIVE ${token} AS (SELECT 1 AS v) SELECT * FROM "${name}"`,
        `WITH seed AS (SELECT 1), ${token} AS (SELECT * FROM seed) SELECT * FROM "${name}"`,
        `WITH t(first_col, ${token}) AS (SELECT 1, 2) SELECT * FROM t`,
      ]) {
        const parsed = Effect.runSync(Effect.result(sqlQuery.decode(source)));
        let rows;
        try {
          rows = db.prepare(source).all();
        } catch {
          assert.ok(Result.isFailure(parsed), source);
          continue;
        }
        assert.ok(Result.isSuccess(parsed), source);
        const rendered = Effect.runSync(sqlQuery.encode(parsed.success));
        assert.deepEqual(decode(rendered), parsed.success, source);
        assert.deepEqual(db.prepare(rendered).all(), rows, source);
      }
    }
  }
});

test("CTEs retain SQLite's implicit, explicit and declared names for likelihood calls", () => {
  using db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE input(v INTEGER); INSERT INTO input VALUES (7)");
  for (const { definition, labels } of [
    {
      definition:
        "c AS (SELECT LiKeLy ( v ), UnLiKeLy(  v ), LiKeLiHoOd (v,  0.5), likely(v) AS kept FROM input)",
      labels: ["LiKeLy ( v )", "UnLiKeLy(  v )", "LiKeLiHoOd (v,  0.5)", "kept"],
    },
    {
      definition: "c(first, second) AS (SELECT LiKeLy ( v ), unlikely(v) AS overridden FROM input)",
      labels: ["first", "second"],
    },
  ]) {
    const references = labels.map((label) => `c."${label}"`).join(", ");
    const source = `WITH ${definition} SELECT ${references} FROM c`;
    const ast = decode(source);
    const rendered = Effect.runSync(sqlQuery.encode(ast));
    const original = db.prepare(source);
    const formatted = db.prepare(rendered);
    assert.deepEqual(
      original.columns().map(({ name }) => name),
      labels,
      source,
    );
    assert.deepEqual(formatted.columns(), original.columns(), source);
    assert.deepEqual(
      Object.values(original.get()!),
      labels.map(() => 7),
      source,
    );
    assert.deepEqual(formatted.all(), original.all(), source);
    assert.deepEqual(decode(rendered), ast, source);
  }
});

test("WITH rejects incomplete definitions and empty constructed lists", () => {
  for (const source of [
    "WITH",
    "WITH RECURSIVE",
    "WITH x SELECT 1",
    "WITH x() AS (SELECT 1) SELECT 1",
    "WITH x AS () SELECT 1",
    "WITH x AS NOT (SELECT 1) SELECT 1",
    "WITH x AS (SELECT 1), SELECT 1",
    "WITH x AS (SELECT 1)",
    "SELECT 1 UNION WITH x AS (SELECT 1) SELECT 1",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
  const query: Query = {
    _tag: "ValuesQuery",
    rows: [[{ _tag: "NumericLiteral", value: "1" }]],
    with: { expressions: [], recursive: false },
  };
  assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.encode(query)))));
});
