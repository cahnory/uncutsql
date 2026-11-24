import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { sqlQuery } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";

const decode = (sql: string) => Effect.runSync(sqlQuery.decode(sql));

test("joins preserve SQLite outer rows, constraints, order and planner choices", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE a(id,av); CREATE TABLE b(id,bv); CREATE TABLE c(id); INSERT INTO a VALUES(1,'a'),(2,'b'); INSERT INTO b VALUES(2,'c'),(3,'d'); INSERT INTO c VALUES(2),(3)",
  );
  try {
    for (const source of [
      "SELECT a.id AS ai,b.id AS bi FROM a JOIN b ON a.id=b.id",
      "SELECT * FROM a LEFT OUTER JOIN b USING(id) ORDER BY id",
      "SELECT * FROM a RIGHT JOIN b USING(id) ORDER BY id",
      "SELECT * FROM a FULL OUTER JOIN b USING(id) ORDER BY id",
      "SELECT * FROM a NATURAL JOIN b",
      "SELECT * FROM a NATURAL LEFT JOIN b ORDER BY id",
      "SELECT * FROM a CROSS JOIN b ORDER BY a.id,b.id",
      "SELECT * FROM a,b ON a.id=b.id",
      "SELECT * FROM a CROSS JOIN b ON a.id=b.id",
      "SELECT * FROM a LEFT RIGHT JOIN b USING(id) ORDER BY id",
      "SELECT a.id AS ai,b.id AS bi,c.id AS ci FROM a LEFT JOIN (b JOIN c USING(id)) ON a.id=b.id ORDER BY ai,bi,ci",
      "SELECT * FROM (a NATURAL JOIN b) AS pair",
      "SELECT * FROM (a,b) WHERE a.id=b.id",
      "SELECT * FROM ((SELECT 1 AS id)) AS nested",
      "SELECT * FROM ((a)) AS x WHERE x.id=1",
      "SELECT * FROM a OUTER LEFT JOIN b USING(id) ORDER BY id",
      "SELECT * FROM a NATURAL NATURAL JOIN b",
      "SELECT * FROM a LEFT LEFT LEFT JOIN b USING(id)",
      "SELECT a.id AS ai,b.id AS bi,c.id AS ci FROM a,b LEFT JOIN c ON c.id=a.id ORDER BY ai,bi,ci",
      "SELECT * FROM (SELECT 2 AS id) x JOIN a USING(id)",
      "SELECT * FROM a JOIN b ON a.id=b.id AND EXISTS(SELECT 1 FROM c WHERE c.id=a.id)",
    ]) {
      const value = decode(source);
      const rendered = Effect.runSync(sqlQuery.encode(value));
      assert.deepEqual(decode(rendered), value);
      assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all(), source);
      assert.deepEqual(
        db.prepare(`EXPLAIN QUERY PLAN ${rendered}`).all(),
        db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(),
        source,
      );
    }
  } finally {
    db.close();
  }
});

test("USING column names match SQLite and preserve multi-column join results", () => {
  using db = new DatabaseSync(":memory:");
  const names = [...keywords].map((word) => word[0] + word.slice(1).toLowerCase());
  for (const name of [...names, "owner's key"]) {
    db.exec(`
      CREATE TABLE a("${name}", group_id);
      CREATE TABLE b("${name}", group_id, marker);
      INSERT INTO a VALUES (1, 2);
      INSERT INTO b VALUES (1, 1, 'group differs'), (2, 2, 'name differs'), (1, 2, 'both match');
    `);
    for (const token of [name, `'${name.replaceAll("'", "''")}'`]) {
      const source = `SELECT marker FROM a JOIN b USING (group_id, ${token})`;
      const parsed = Effect.runSync(Effect.result(sqlQuery.decode(source)));
      let rows;
      try {
        rows = db.prepare(source).all();
      } catch {
        assert.ok(Result.isFailure(parsed), source);
        continue;
      }
      assert.ok(Result.isSuccess(parsed), source);
      assert.deepEqual(
        rows.map((row) => row.marker),
        ["both match"],
        source,
      );
      const rendered = Effect.runSync(sqlQuery.encode(parsed.success));
      assert.deepEqual(decode(rendered), parsed.success, source);
      assert.deepEqual(db.prepare(rendered).all(), rows, source);
    }
    db.exec("DROP TABLE a; DROP TABLE b");
  }
});

test("invalid join types and contradictory natural constraints fail", () => {
  for (const source of [
    "a LEFT",
    "a LEFT JOIN",
    "a JOIN b USING()",
    "a JOIN b ON",
    "a NATURAL JOIN b ON 1",
    "a NATURAL JOIN b USING(id)",
    "a INNER OUTER JOIN b",
    "a OUTER JOIN b",
    "a LEFT LEFT LEFT LEFT JOIN b",
    "a LEFT CROSS JOIN b",
    "a JOIN b ON 1 USING(id)",
  ]) {
    assert.ok(
      Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(`SELECT * FROM ${source}`)))),
      source,
    );
  }
  const ast = decode("SELECT * FROM a NATURAL JOIN b");
  assert.equal(ast._tag, "SelectQuery");
  if (ast._tag !== "SelectQuery" || ast.from === undefined || !("_tag" in ast.from)) {
    throw new Error("Expected joined source");
  }
  assert.ok(
    Result.isFailure(
      Effect.runSync(
        Effect.result(
          sqlQuery.encode({
            ...ast,
            from: {
              ...ast.from,
              joins: ast.from.joins.map((join) => ({
                ...join,
                constraint: { _tag: "Using" as const, columns: ["id"] },
              })),
            },
          }),
        ),
      ),
    ),
  );
});

for (const group of ["join-clause", "join-constraint", "join-operator", "table-or-subquery"]) {
  const root = new URL(`./fixtures/previous/${group}/`, import.meta.url);
  for (const category of readdirSync(root)) {
    for (const file of readdirSync(new URL(category + "/", root))) {
      test(`previous ${group}/${category}/${file}`, () => {
        const source = readFileSync(new URL(category + "/" + file, root), "utf8");
        const sql =
          group === "join-operator"
            ? `SELECT * FROM a ${source} b`
            : group === "join-constraint"
              ? `SELECT * FROM a JOIN b ${source}`
              : `SELECT * FROM ${source}`;
        const result = Effect.runSync(Effect.result(sqlQuery.decode(sql)));
        if (category === "invalid") {
          assert.ok(Result.isFailure(result), source);
        } else {
          assert.ok(Result.isSuccess(result), source);
          assert.deepEqual(decode(Effect.runSync(sqlQuery.encode(result.success))), result.success);
        }
      });
    }
  }
}
