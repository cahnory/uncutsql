import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { document, EncodeError, ParseError } from "@uncutsql/codec";
import { sqlExpression, expression, createTable, type FunctionCall } from "../src/index.ts";
import { orderingTerm } from "../src/codecs/ordering-term.ts";
import { trivia } from "../src/operators/trivia.ts";
const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (sql: string) => Effect.runSync(sqlExpression.encode(decode(sql)));

test("aggregate modifiers, ordering and filters retain native SQLite results", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(value, name); INSERT INTO t VALUES(2,'B'),(1,'a'),(2,'b'),(NULL,'z')");
  try {
    for (const source of [
      "count(*)",
      "count(DISTINCT value)",
      "sum(ALL value)",
      "group_concat(name ORDER BY value DESC NULLS LAST, name COLLATE NOCASE ASC)",
      "group_concat(name, ':' ORDER BY name DESC)",
      "sum(value) FILTER (WHERE value > 1)",
      "count(*) FILTER (WHERE value IS NULL)",
      "count(ORDER BY name)",
      "group_concat(DISTINCT name ORDER BY name) FILTER(WHERE value IN(1,2))",
    ]) {
      const sql = encode(source);
      assert.deepEqual(decode(sql), decode(source));
      assert.deepEqual(
        db.prepare(`SELECT ${sql} AS result FROM t`).get(),
        db.prepare(`SELECT ${source} AS result FROM t`).get(),
        source,
      );
    }
  } finally {
    db.close();
  }
  assert.equal(encode("lower('ABC')"), `"lower"('ABC')`);
});

test("malformed aggregate clauses and contradictory constructed arguments fail", () => {
  for (const source of [
    "count(*,1)",
    "count(DISTINCT *)",
    "count(* ORDER BY 1)",
    "sum(1 ORDER)",
    "sum(1 ORDER BY)",
    "sum(1) FILTER()",
    "sum(1) FILTER(1)",
    "sum(1 ORDER BY 1 NULLS)",
    "sum(1 ORDER BY 1 NULLS MIDDLE)",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result), source);
    assert.ok(result.failure instanceof ParseError);
  }
  const value: FunctionCall = {
    _tag: "FunctionCall",
    name: "count",
    arguments: [{ _tag: "NumericLiteral", value: "1" }],
    star: true,
  };
  const result = Effect.runSync(Effect.result(sqlExpression.encode(value)));
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EncodeError);
  assert.ok(
    Result.isFailure(
      Effect.runSync(
        Effect.result(
          sqlExpression.encode({ _tag: "FunctionCall", name: "sum", arguments: [], orderBy: [] }),
        ),
      ),
    ),
  );
  // Arity and whether a function is an aggregate are SQLite's responsibilities.
  assert.equal(decode("count(DISTINCT)")._tag, "FunctionCall");
});

test("default validation traverses aggregate ordering and filter expressions", () => {
  for (const source of ["sum(1 ORDER BY a)", "sum(1) FILTER(WHERE a)", "sum(1 ORDER BY ?)"]) {
    assert.ok(
      Result.isFailure(
        Effect.runSync(
          Effect.result(createTable.decode(`CREATE TABLE t(a, b DEFAULT (${source}))`)),
        ),
      ),
    );
  }
});

for (const group of ["ordering-term", "filter-clause"]) {
  const root = new URL(`./fixtures/previous/${group}/`, import.meta.url);
  for (const category of readdirSync(root))
    for (const file of readdirSync(new URL(category + "/", root))) {
      test(`previous ${group}/${category}/${file}`, () => {
        const source = readFileSync(new URL(category + "/" + file, root), "utf8");
        const valid = category !== "invalid";
        if (group === "ordering-term") {
          const codec = document(orderingTerm(expression), trivia);
          const result = Effect.runSync(Effect.result(codec.decode(source)));
          if (valid) {
            assert.ok(Result.isSuccess(result));
            assert.deepEqual(
              Effect.runSync(codec.decode(Effect.runSync(codec.encode(result.success)))),
              result.success,
            );
          } else {
            assert.ok(Result.isFailure(result));
          }
        } else {
          const result = Effect.runSync(Effect.result(sqlExpression.decode(`count(*) ${source}`)));
          if (valid) {
            assert.ok(Result.isSuccess(result));
            assert.deepEqual(decode(encode(`count(*) ${source}`)), result.success);
          } else {
            assert.ok(Result.isFailure(result));
          }
        }
      });
    }
}
