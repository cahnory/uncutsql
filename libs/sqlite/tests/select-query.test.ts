import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
  db.exec("CREATE TEMP TABLE 'Raise'('Cast'); INSERT INTO temp.'Raise' VALUES(7)");
  try {
    for (const source of [
      "SELECT 1 AS value",
      "SELECT Temp.'Raise'.Cast, 'Temp'.Raise.'Cast' AS other FROM temp.'Raise'",
      "WITH Abort(v) AS (VALUES(1)) SELECT 'Abort', 'Abort'.v, Abort.v AS other FROM Abort",
      "WITH True(v) AS (VALUES(7)) SELECT TRUE, FALSE, True.v, 'True'.v AS other FROM True",
      "WITH Abort(v) AS (VALUES(1)) SELECT 'Abort', 'Abort'.* FROM Abort",
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

test("qualified stars match SQLite for bare and quoted keyword table names", () => {
  using db = new DatabaseSync(":memory:");
  for (const word of [...keywords, "owner's table"]) {
    const name = word[0] + word.slice(1).toLowerCase();
    for (const token of [name, `'${name.replaceAll("'", "''")}'`]) {
      const source = `SELECT ${token}.* FROM (SELECT 1 AS v, 2 AS w) AS "${name}"`;
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
});

test("qualified column names match SQLite at each position", () => {
  using db = new DatabaseSync(":memory:");
  for (const word of [...keywords, "owner's name"]) {
    const name = word[0] + word.slice(1).toLowerCase();
    db.exec(`CREATE TABLE "${name}"("${name}"); INSERT INTO "${name}" VALUES(7)`);
    for (const token of [name, `'${name.replaceAll("'", "''")}'`]) {
      for (const reference of [
        `${token}."${name}"`,
        `"${name}".${token}`,
        `main.${token}."${name}"`,
        `main."${name}".${token}`,
      ]) {
        const source = `SELECT ${reference} FROM "${name}"`;
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
    db.exec(`DROP TABLE "${name}"`);
  }
});

test("unqualified keyword expressions match SQLite for every dialect keyword", () => {
  using db = new DatabaseSync(":memory:");
  for (const keyword of keywords) {
    const name = keyword[0] + keyword.slice(1).toLowerCase();
    const source = `SELECT ${name} FROM (SELECT 7 AS "${keyword}")`;
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
    assert.deepEqual(decode(rendered), parsed.success, source);
    assert.deepEqual(
      db
        .prepare(rendered)
        .columns()
        .map(({ name }) => name),
      native.columns().map(({ name }) => name),
      source,
    );
    // Evaluate both forms in one SQLite statement so date/time literals share a clock.
    const row = db
      .prepare(`SELECT (${source}) AS original, (${rendered.slice(0, -1)}) AS formatted`)
      .get()!;
    assert.equal(row.formatted, row.original, source);
    if (keyword.startsWith("CURRENT_")) {
      assert.equal(typeof row.original, "string", source);
    } else {
      assert.equal(row.original, keyword === "NULL" ? null : 7, source);
    }
  }
});

test("unqualified contextual columns preserve SELECT clause boundaries and labels", () => {
  using db = new DatabaseSync(":memory:");
  db.exec('CREATE TABLE flags("TRUE", "FALSE"); INSERT INTO flags VALUES (7, 8)');
  const example = "SELECT Abort FROM (SELECT 7 AS Abort)";
  for (const source of [
    example,
    "SELECT Abort Offset, Sum(Abort) OVER Window AS Total FROM (SELECT 7 AS Abort) WHERE Abort > 0 GROUP BY Abort HAVING Abort > 1 WINDOW Window AS () ORDER BY Offset DESC LIMIT 1 OFFSET 0",
    "SELECT Like LIKE 'a%' AS Matches, Indexed, Filter, Over, Window FROM (SELECT 'abc' AS Like, 2 AS Indexed, 3 AS Filter, 4 AS Over, 5 AS Window)",
    "SELECT (SELECT Window) FROM (SELECT 7 AS Window)",
    "SELECT TrUe, FaLsE",
    'SELECT TRUE, FALSE, "TRUE" AS true_column, "FALSE" AS false_column FROM flags',
  ]) {
    const parsed = decode(source);
    const rendered = Effect.runSync(sqlQuery.encode(parsed));
    assert.deepEqual(decode(rendered), parsed, source);
    assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all(), source);
  }
  assert.equal(db.prepare(Effect.runSync(sqlQuery.encode(decode(example)))).get()?.Abort, 7);
});

test("unaliased boolean results retain SQLite's labels for columns and literals", () => {
  using db = new DatabaseSync(":memory:");
  db.exec('CREATE TABLE flags("True", "False"); INSERT INTO flags VALUES (7, 8)');
  const cases = [
    { labels: ["True", "False"], source: "SELECT TRUE, FALSE FROM flags", values: [7, 8] },
    { labels: ["True", "False"], source: "SELECT (TrUe), ((FaLsE)) FROM flags", values: [7, 8] },
    {
      labels: ["TrUe", "FaLsE"],
      source: "SELECT TrUe, FaLsE FROM (SELECT 1 AS v)",
      values: [1, 0],
    },
    { labels: ["(TrUe)", "((FaLsE))"], source: "SELECT (TrUe), ((FaLsE))", values: [1, 0] },
    {
      labels: ["yes", "no"],
      source: "SELECT TRUE AS yes, FALSE AS no FROM flags",
      values: [7, 8],
    },
  ];
  for (const { labels, source, values } of cases) {
    const parsed = decode(source);
    const rendered = Effect.runSync(sqlQuery.encode(parsed));
    const original = db.prepare(source);
    const formatted = db.prepare(rendered);
    assert.deepEqual(
      original.columns().map(({ name }) => name),
      labels,
      source,
    );
    assert.deepEqual(Object.values(original.get()!), values, source);
    assert.deepEqual(formatted.columns(), original.columns(), source);
    assert.deepEqual(formatted.all(), original.all(), source);
    assert.deepEqual(decode(rendered), parsed, source);
  }
});

test("collated boolean results retain SQLite's derived and top-level names", () => {
  using db = new DatabaseSync(":memory:");
  db.exec('CREATE TABLE flags("True", "False"); INSERT INTO flags VALUES (7, 8)');
  const expressions = [
    "TrUe cOlLaTe binary",
    '((FaLsE) COLLATE "nocase" COLLATE binary) /* end */',
  ];
  for (const { from, values } of [
    { from: " FROM flags", values: [7, 8] },
    { from: " FROM (SELECT 1 AS v)", values: [1, 0] },
  ]) {
    const select = `SELECT ${expressions.join(", ")}${from}`;
    for (const { labels, source } of [
      { labels: ["column1", "column2"], source: `SELECT * FROM (${select})` },
      { labels: ["column1", "column2"], source: `WITH q AS (${select}) SELECT * FROM q` },
      { labels: expressions, source: select },
      {
        labels: ["yes", "no"],
        source: `SELECT * FROM (SELECT ${expressions[0]} AS yes, ${expressions[1]} AS no${from})`,
      },
    ]) {
      const parsed = decode(source);
      const rendered = Effect.runSync(sqlQuery.encode(parsed));
      const original = db.prepare(source);
      const formatted = db.prepare(rendered);
      assert.deepEqual(
        original.columns().map(({ name }) => name),
        labels,
        source,
      );
      assert.deepEqual(Object.values(original.get()!), values, source);
      assert.deepEqual(formatted.columns(), original.columns(), source);
      assert.deepEqual(formatted.all(), original.all(), source);
      assert.deepEqual(decode(rendered), parsed, source);
    }
  }
});

test("trailing comments preserve native computed result labels and values", () => {
  using db = new DatabaseSync(":memory:");
  db.exec('CREATE TABLE t(v, "True"); INSERT INTO t VALUES (7, 8)');
  const cases = [
    {
      labels: ['1+2 /* "block" */', "4+5 -- line"],
      source: 'SELECT 1+2 /* "block" */ \t, 4+5 -- line \t\r\n  ;',
      values: [3, 9],
    },
    {
      labels: ["v+2 /* first */ -- second \r\n /* last */"],
      source: "SELECT v+2 /* first */ -- second \r\n /* last */  FROM t",
      values: [9],
    },
    {
      labels: ["1+2 -- EOF\u00a0"],
      source: "SELECT 1+2 -- EOF\u00a0  ",
      values: [3],
    },
    {
      labels: ["1+2 /* open"],
      source: "SELECT 1+2 /* open  ",
      values: [3],
    },
    {
      labels: ["1+2 -- derived"],
      source: "SELECT * FROM (SELECT 1+2 -- derived\n )",
      values: [3],
    },
    {
      labels: ["v", "named", "implicit", "1+2", "flag"],
      source:
        "SELECT /* leading */ v /* direct */, v+2 /* explicit */ AS named /* after alias */, " +
        "v+3 -- implicit\n implicit, 1+2 \t, True /* boolean */ AS flag FROM t; /* after ; */",
      values: [7, 9, 10, 3, 8],
    },
    {
      labels: ["v COLLATE binary /* top-level */"],
      source: "SELECT v COLLATE binary /* top-level */ FROM t",
      values: [7],
    },
    {
      labels: ["v"],
      source: "SELECT * FROM (SELECT v COLLATE binary /* derived direct */ FROM t)",
      values: [7],
    },
    {
      labels: ["(TrUe) -- literal", "FaLsE /* literal */"],
      source: "SELECT (TrUe) -- literal\n , FaLsE /* literal */",
      values: [1, 0],
    },
    {
      labels: ["TrUe /* open"],
      source: "SELECT TrUe /* open  ",
      values: [1],
    },
    {
      labels: ["FaLsE -- EOF"],
      source: "SELECT FaLsE -- EOF",
      values: [0],
    },
    {
      labels: ["True", "FaLsE /* literal */"],
      source: "SELECT TrUe -- shadowed\n , FaLsE /* literal */ FROM t",
      values: [8, 0],
    },
  ];
  for (const { labels, source, values } of cases) {
    const original = db.prepare(source);
    assert.deepEqual(
      original.columns().map(({ name }) => name),
      labels,
      source,
    );
    assert.deepEqual(Object.values(original.get()!), values, source);

    const parsed = decode(source);
    const rendered = Effect.runSync(sqlQuery.encode(parsed));
    const formatted = db.prepare(rendered);
    assert.deepEqual(formatted.columns(), original.columns(), source);
    assert.deepEqual(formatted.all(), original.all(), source);
    assert.deepEqual(decode(rendered), parsed, source);
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

test("named window declarations, references and base names match SQLite", () => {
  using db = new DatabaseSync(":memory:");
  for (const name of [...keywords, "'it''s a window'"]) {
    for (const source of [
      `SELECT sum(1) OVER ${name} WINDOW ${name} AS ()`,
      `SELECT sum(1) OVER ( ${name} ) WINDOW w AS (), ${name} AS ()`,
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
      assert.deepEqual(decode(rendered), parsed.success, source);
      assert.deepEqual(db.prepare(rendered).all(), native.all(), source);
    }
  }
});

test("implicit keyword aliases preserve spelling and following clause boundaries", () => {
  using db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(v); INSERT INTO t VALUES (1); CREATE INDEX ix ON t(v)");
  for (const source of [
    'SELECT v KeY FROM t TEMP WHERE "TEMP".v = 1 ORDER BY "KeY"',
    'SELECT "Like".v RoW FROM t Like INDEXED BY ix',
    "SELECT v WiNdOw, length(v) FiLtEr, count(*) OvEr FROM t",
    "SELECT count(*) FILTER (WHERE v > 0) OvEr FROM t",
    "SELECT sum(v) OVER () WiNdOw FROM t",
    "SELECT (1) filter /* comment */ WINDOW w AS ()",
    "SELECT 1 over WINDOW w AS ()",
    "SELECT 1 + $x(suffix) over WINDOW w AS ()",
    "SELECT count(*) window WINDOW /* name */ w /* declaration */ AS ()",
    'SELECT "over".v FROM t over WINDOW w AS ()',
    'SELECT "filter".v FROM (SELECT 1 AS v) filter',
    'SELECT "window".v FROM t window WHERE v = 1',
    "SELECT 1 Current_Date, 2 By LIMIT 1 OFFSET 0",
    "SELECT v LIKE 1 MaTeRiAlIzEd FROM t LEFT JOIN (SELECT 1 AS n) ON n = v",
    "SELECT sum(v) FILTER (WHERE v > 0) OVER w KeY FROM t WINDOW w AS ()",
  ]) {
    const parsed = decode(source);
    const rendered = Effect.runSync(sqlQuery.encode(parsed));
    assert.deepEqual(decode(rendered), parsed, source);
    assert.deepEqual(db.prepare(rendered).all(), db.prepare(source).all(), source);
  }
  for (const source of [
    "SELECT 1 LEFT",
    "SELECT 1 GLOB",
    "SELECT * FROM t INDEXED",
    "SELECT (1) over WINDOW w AS ()",
    "SELECT (1 + $x(suffix)) over WINDOW w AS ()",
    "SELECT count(*) over WINDOW w AS ()",
    "SELECT count(*) filter (v)",
    "SELECT count(*) over (",
    "SELECT * FROM (SELECT 1) over WINDOW w AS ()",
  ]) {
    assert.throws(() => db.prepare(source), source);
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
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
    "SELECT Abort FROM",
    "SELECT Abort FROM (SELECT 7 AS Abort) ORDER BY",
    "SELECT Abort FROM (SELECT 7 AS Abort) LIMIT 1 OFFSET",
  ]) {
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(sqlQuery.decode(source)))), source);
  }
});

const root = new URL("./fixtures/previous/select-core/", import.meta.url);
for (const category of readdirSync(root)) {
  for (const file of readdirSync(new URL(category + "/", root))) {
    test(`previous select-core/${category}/${file}`, () => {
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
