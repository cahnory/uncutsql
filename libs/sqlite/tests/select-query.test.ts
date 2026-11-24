import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { sqlQuery } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";
const decode = (source: string) => Effect.runSync(sqlQuery.decode(source));

test("SELECT cores preserve native results, aliases and window names", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE t(value, category); INSERT INTO t VALUES(1,'a'),(2,'a'),(NULL,'b'),(3,'b')",
  );
  try {
    for (const source of [
      "SELECT 1 AS value",
      "SELECT 'value' AS label, value FROM 'main'.'t' ORDER BY value",
      "SELECT x.value AS 'it''s a label' FROM t AS 'x' ORDER BY x.value",
      "SELECT 'literal' 'select' FROM t 'source' ORDER BY source.value",
      "SELECT DISTINCT category FROM t ORDER BY category",
      "SELECT ALL t.* FROM main.t ORDER BY value DESC NULLS LAST",
      "SELECT * FROM t WHERE value BETWEEN 1 AND 2 ORDER BY value",
      "SELECT x.value v, x.category AS c FROM t x WHERE x.value IS NOT NULL ORDER BY v",
      "SELECT category, sum(value) AS total FROM t GROUP BY category HAVING sum(value) > 1 ORDER BY total DESC",
      "SELECT count(*) AS n FROM t HAVING count(*) > 0",
      "SELECT a.value AS a, b.value AS b FROM t a, t b WHERE a.value = b.value ORDER BY a,b",
      "SELECT name FROM pragma_table_info('t') ORDER BY cid",
      "SELECT sum(value) OVER w AS total FROM t WINDOW w AS (PARTITION BY category) ORDER BY value",
      'SELECT sum(value) OVER "w" AS total FROM t WINDOW "w" AS (ORDER BY value ROWS UNBOUNDED PRECEDING) ORDER BY value',
      "SELECT sum(value) OVER next AS total FROM t WINDOW base AS (PARTITION BY category), next AS (base ORDER BY value) ORDER BY value",
      "SELECT value + 2 AS result FROM t ORDER BY result",
    ]) {
      const value = decode(source);
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(decode(rendered), value);
      assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all(), source);
    }
  } finally {
    db.close();
  }
});

test("explicit result and source aliases match SQLite for every dialect keyword", () => {
  using db = new DatabaseSync(":memory:");
  for (const keyword of keywords) {
    const name = keyword[0] + keyword.slice(1).toLowerCase();
    for (const source of [
      `SELECT 1 AS ${name}`,
      `SELECT "${name}".v FROM (SELECT 1 AS v) AS ${name}`,
    ]) {
      const parsed = Effect.runSync(Effect.result(sqlQuery.decode(source)));
      let native;
      try {
        native = db.prepare(source);
      } catch {
        assert.ok(Result.isFailure(parsed), source);
        continue;
      }
      assert.ok(Result.isSuccess(parsed), source);
      const rendered = Effect.runSync(sqlQuery.encode(parsed.success));
      assert.ok(rendered.includes(`AS "${name}"`), rendered);
      assert.deepEqual(decode(rendered), parsed.success, source);
      assert.deepEqual(db.prepare(rendered).all(), native.all(), source);
    }
  }
});

test("SELECT rejects incomplete clauses ", () => {
  for (const source of [
    "SELECT",
    "SELECT FROM t",
    "SELECT 1,",
    "SELECT 1 AS",
    "SELECT * FROM",
    "SELECT * FROM t AS",
    "SELECT 1 WHERE",
    "SELECT 1 GROUP BY",
    "SELECT 1 ORDER BY",
    "SELECT 1 WINDOW w AS",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
});

const root = new URL("./fixtures/previous/select-core/", import.meta.url);
for (const category of readdirSync(root))
  for (const file of readdirSync(new URL(category + "/", root))) {
    test(`previous select-core/${category}/${file}`, () => {
      const source = readFileSync(new URL(category + "/" + file, root), "utf8");
      const result = Effect.runSync(Effect.result(sqlQuery.decode(source)));
      if (category === "invalid") assert.ok(Result.isFailure(result));
      else {
        assert.ok(Result.isSuccess(result));
        assert.deepEqual(decode(Effect.runSync(sqlQuery.encode(result.success))), result.success);
      }
    });
  }
