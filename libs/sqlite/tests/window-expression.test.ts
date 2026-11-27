import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { createTable, sqlExpression } from "../src/index.ts";
import type { FunctionCall } from "../src/index.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (sql: string) => Effect.runSync(sqlExpression.encode(decode(sql)));

test("window expressions preserve native SQLite results and ASTs", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE t(value, category); INSERT INTO t VALUES(1,'a'),(2,'a'),(2,'a'),(NULL,'b'),(3,'b')",
  );
  try {
    for (const source of [
      "row_number() OVER ()",
      "sum(value) OVER w",
      "sum(value) OVER (w ORDER BY value)",
      "sum(value) FILTER (WHERE value > 1) OVER (PARTITION BY category)",
      "sum(value) OVER (ORDER BY value DESC NULLS LAST ROWS UNBOUNDED PRECEDING)",
      "sum(value) OVER (ORDER BY value RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING)",
      "sum(value) OVER (ORDER BY value GROUPS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)",
      ...["NO OTHERS", "CURRENT ROW", "GROUP", "TIES"].map(
        (exclude) =>
          `sum(value) OVER (ORDER BY value ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE ${exclude})`,
      ),
    ]) {
      const rendered = encode(source);
      assert.deepEqual(decode(rendered), decode(source));
      const query = (expr: string) =>
        `SELECT ${expr} AS result FROM t WINDOW w AS (PARTITION BY category)`;
      assert.deepEqual(db.prepare(query(rendered)).all(), db.prepare(query(source)).all(), source);
    }
  } finally {
    db.close();
  }
});

test("malformed windows and impossible boundary directions fail", () => {
  for (const source of [
    "sum(1) OVER",
    "sum(1) OVER (PARTITION BY)",
    "sum(1) OVER (ORDER BY)",
    "sum(1) OVER (ROWS UNBOUNDED FOLLOWING)",
    "sum(1) OVER (ROWS BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING)",
    "sum(1) OVER (ROWS BETWEEN 1 PRECEDING)",
    "sum(1) OVER (ROWS CURRENT ROW EXCLUDE)",
    "sum(1) OVER (ROWS CURRENT ROW EXCLUDE INVALID)",
    "sum(1) OVER () FILTER (WHERE 1)",
  ]) {
    assert.ok(
      Result.isFailure(Effect.runSync(Effect.result(sqlExpression.decode(source)))),
      source,
    );
  }
  const value: FunctionCall = {
    _tag: "FunctionCall",
    arguments: [],
    name: "sum",
    over: {
      _tag: "WindowDefinition",
      frame: { start: { _tag: "SpecialBoundary", value: "UNBOUNDED FOLLOWING" }, unit: "ROWS" },
    },
  };
  assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlExpression.encode(value)))));
});

test("bare CURRENT and UNBOUNDED start special window frame bounds", () => {
  using db = new DatabaseSync(":memory:");
  for (const source of [
    "sum(1) OVER (ROWS CURRENT PRECEDING)",
    "sum(1) OVER (ROWS UNBOUNDED + 1 PRECEDING)",
    "sum(1) OVER (ROWS UNBOUNDED /* direction */ FOLLOWING)",
    "sum(1) OVER (ROWS BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING)",
  ]) {
    assert.throws(() => db.prepare(`SELECT ${source}`), /syntax error/, source);
    assert.ok(
      Result.isFailure(Effect.runSync(Effect.result(sqlExpression.decode(source)))),
      source,
    );
  }
  assert.equal(
    encode('sum(1) OVER (ROWS "UNBOUNDED" PRECEDING)'),
    '"sum"(1) OVER (ROWS "UNBOUNDED" PRECEDING)',
  );
});

test("window functions cannot be defaults", () => {
  for (const source of ["sum(1) OVER ()", "sum(1) OVER w"]) {
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(createTable.decode(`CREATE TABLE t(a DEFAULT (${source}))`))),
      ),
    );
  }
});

for (const group of ["frame-spec", "over-clause"]) {
  const root = new URL(`./fixtures/previous/${group}/`, import.meta.url);
  for (const category of readdirSync(root)) {
    for (const file of readdirSync(new URL(category + "/", root))) {
      test(`previous ${group}/${category}/${file}`, () => {
        const source = readFileSync(new URL(category + "/" + file, root), "utf8");
        const sql = group === "frame-spec" ? `sum(value) OVER (${source})` : `sum(value) ${source}`;
        const result = Effect.runSync(Effect.result(sqlExpression.decode(sql)));
        if (category === "invalid") {
          assert.ok(Result.isFailure(result));
        } else {
          assert.ok(Result.isSuccess(result));
          assert.deepEqual(decode(encode(sql)), result.success);
        }
      });
    }
  }
}

test("window reference quoting is significant in native SQLite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of ["w", '"w"', "`w`", "[w]", '"a b"']) {
      for (const source of [`sum(1) OVER ${name}`, `sum(1) OVER (${name})`]) {
        const rendered = encode(source);
        assert.deepEqual(
          db.prepare(`SELECT ${rendered} AS result WINDOW ${name} AS ()`).get(),
          db.prepare(`SELECT ${source} AS result WINDOW ${name} AS ()`).get(),
        );
        assert.equal(
          (decode(rendered) as FunctionCall).over?._tag,
          source.includes("OVER (") ? "WindowDefinition" : "NamedWindow",
        );
        assert.deepEqual(decode(rendered), decode(source));
      }
    }
  } finally {
    db.close();
  }
});

test("window names reject injected text when encoding", () => {
  for (const name of ["w; SELECT 1", "w -- comment", "/*comment*/w", " w", ""]) {
    const value: FunctionCall = {
      _tag: "FunctionCall",
      arguments: [],
      name: "sum",
      over: { _tag: "NamedWindow", name },
    };
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlExpression.encode(value)))), name);
  }
  assert.deepEqual(decode("sum(1) OVER /*comment*/ w"), decode("sum(1) OVER w"));
});
