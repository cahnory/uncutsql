import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { document, EncodeError, ParseError, type SourceNode } from "@uncutsql/codec";
import { createIndex, createTable, sqlQuery, tableReference } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";
import { trivia } from "../src/operators/trivia.ts";

const reference = document(tableReference, trivia);

for (const [source, expected] of [
  ["main.t", { schema: "main", name: "t" }],
  ["TeMp /* schema */ .t", { schema: "TeMp", name: "t" }],
  ['"main.t"', { name: "main.t" }],
  ['"a.b"."c.d"', { schema: "a.b", name: "c.d" }],
  ["main /* comment */ . -- comment\n t", { schema: "main", name: "t" }],
  ['"".""', { schema: "", name: "" }],
] as const) {
  test(`table reference retains identifier boundaries: ${source}`, () => {
    assert.deepEqual(Effect.runSync(reference.decode(source)), expected);
    assert.deepEqual(
      Effect.runSync(reference.decode(Effect.runSync(reference.encode(expected)))),
      expected,
    );
  });
}

for (const source of ["main.", "main..t", ".t", "main.t.extra", 'main."unfinished']) {
  test(`malformed qualifier fails through ParseError: ${source}`, () => {
    const result = Effect.runSync(Effect.result(createTable.decode(`CREATE TABLE ${source} (id)`)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof ParseError);
    assert.equal(result.failure.committed, true);
  });
}

test("schema names are encoded as identifiers and reject NUL", () => {
  const ast = Effect.runSync(createTable.decode("CREATE TABLE t (id)"));
  const value = { ...ast, schema: 'a"; DROP TABLE t; --' };
  assert.deepEqual(
    Effect.runSync(createTable.decode(Effect.runSync(createTable.encode(value)))),
    value,
  );
  const result = Effect.runSync(Effect.result(createTable.encode({ ...ast, schema: "a\0b" })));
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EncodeError);
});

for (const source of [
  "CREATE TABLE 'main'.'a.b''s' (id INTEGER PRIMARY KEY)",
  "CREATE TABLE main.t (id INTEGER PRIMARY KEY)",
  "CREATE TABLE temp.t (id INTEGER PRIMARY KEY)",
  "CREATE TEMP TABLE temp.t (id INTEGER PRIMARY KEY)",
  "CREATE TABLE aux.t (id INTEGER PRIMARY KEY)",
  'CREATE TABLE "a.b"."t.x" (id INTEGER PRIMARY KEY)',
]) {
  test(`schema placement survives encoding: ${source}`, () => {
    const ast = Effect.runSync(createTable.decode(source));
    const encoded = Effect.runSync(createTable.encode(ast));
    assert.deepEqual(Effect.runSync(createTable.decode(encoded)), ast);
    const schemas = [];
    for (const sql of [source, encoded]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          `ATTACH ':memory:' AS aux; ATTACH ':memory:' AS "a.b"; CREATE TABLE t (sentinel); CREATE TEMP TABLE t (sentinel);`,
        );
        // Leave the target schema empty, while keeping namesakes in other schemas.
        if (ast.schema === "main" || ast.schema === "temp") db.exec(`DROP TABLE ${ast.schema}.t`);
        db.exec(sql);
        const schema = '"' + ast.schema!.replaceAll('"', '""') + '"';
        const name = '"' + ast.name.replaceAll('"', '""') + '"';
        db.exec(`INSERT INTO ${schema}.${name} VALUES (42)`);
        assert.equal(db.prepare(`SELECT id FROM ${schema}.${name}`).get()!.id, 42);
        schemas.push(db.prepare("PRAGMA table_list").all());
        // IF NOT EXISTS must check the qualified schema, even with namesakes elsewhere.
        db.exec(Effect.runSync(createTable.encode({ ...ast, ifNotExists: true })));
      } finally {
        db.close();
      }
    }
    assert.deepEqual(schemas[0], schemas[1]);
  });
}

test("schema existence and TEMP/schema conflicts remain SQLite validation", () => {
  for (const source of ["CREATE TABLE missing.t (id)", "CREATE TEMP TABLE main.t (id)"]) {
    const ast = Effect.runSync(createTable.decode(source));
    const encoded = Effect.runSync(createTable.encode(ast));
    const db = new DatabaseSync(":memory:");
    try {
      assert.throws(() => db.exec(source));
      assert.throws(() => db.exec(encoded));
    } finally {
      db.close();
    }
  }
});

test("qualification is not accepted on a REFERENCES target", () => {
  const result = Effect.runSync(
    Effect.result(createTable.decode("CREATE TABLE aux.t (id REFERENCES main.parent(id))")),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof ParseError);
});

test("qualified names retain separate identifier source spans", () => {
  const source = "CREATE TABLE /*before*/ [main] /*between*/ . `t` (id)";
  const parsed = Effect.runSync(createTable.decodeWithSourceMap(source));
  const flatten = (nodes: readonly SourceNode[]): readonly SourceNode[] =>
    nodes.flatMap((n) => [n, ...flatten(n.children)]);
  const nodes = flatten(parsed.sourceMap);
  assert.deepEqual(
    nodes.filter((n) => n.kind === "Identifier").map((n) => source.slice(n.start, n.end)),
    ["[main]", "`t`", "id"],
  );
  const node = nodes.find((n) => n.kind === "TableReference")!;
  assert.equal(source.slice(node.start, node.end), "[main] /*between*/ . `t`");
});

test("contextual relation names match SQLite in declarations and joined sources", () => {
  for (const keyword of keywords) {
    using db = new DatabaseSync(":memory:");
    const name = keyword[0] + keyword.slice(1).toLowerCase();
    if (keyword !== "TEMP") db.exec(`ATTACH ':memory:' AS "${name}"`);
    for (const target of [name, `main.${name}`, `${name}.t`, `IF NOT EXISTS ${name}`]) {
      const source = `CREATE TABLE ${target} (v)`;
      const parsed = Effect.runSync(Effect.result(createTable.decode(source)));
      try {
        db.prepare(source);
      } catch {
        assert.ok(Result.isFailure(parsed), source);
        continue;
      }
      assert.ok(Result.isSuccess(parsed), source);
      assert.equal(parsed.success.name, target.endsWith(".t") ? "t" : name);
      const rendered = Effect.runSync(createTable.encode(parsed.success));
      db.prepare(rendered);
      assert.deepEqual(Effect.runSync(createTable.decode(rendered)), parsed.success);
    }

    db.exec(`CREATE TABLE main."${name}" (v); INSERT INTO main."${name}" VALUES (4);
             CREATE TABLE "${name}".t (v); INSERT INTO "${name}".t VALUES (7)`);
    for (const source of [
      `SELECT * FROM ${name}`,
      `SELECT * FROM main.${name}`,
      `SELECT * FROM ${name} LEFT JOIN ${name}.t USING (v)`,
      `SELECT a.v AS lhs, b.v AS rhs FROM ${name}.t a LEFT JOIN ${name} b ON 1`,
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
      assert.deepEqual(db.prepare(rendered).all(), native.all(), source);
      assert.deepEqual(Effect.runSync(sqlQuery.decode(rendered)), parsed.success);
    }
  }
});

test("a leading IF commits an index declaration to IF NOT EXISTS", () => {
  using db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(v)");
  const invalid = "CREATE INDEX If ON t(v)";
  assert.throws(() => db.prepare(invalid));
  assert.ok(Result.isFailure(Effect.runSync(Effect.result(createIndex.decode(invalid)))));
  for (const source of ["CREATE INDEX main.If ON t(v)", "CREATE INDEX IF NOT EXISTS If ON t(v)"]) {
    const parsed = Effect.runSync(createIndex.decode(source));
    assert.equal(parsed.name, "If");
    db.prepare(source);
    db.prepare(Effect.runSync(createIndex.encode(parsed)));
  }
});
