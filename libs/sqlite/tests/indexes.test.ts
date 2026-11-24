import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import {
  diffDatabases,
  planDatabaseMigration,
  decodeDatabaseSchema,
  prepareMigrationDecisions,
  resolveMigrationDecisions,
} from "@uncutsql/core";
import {
  createIndex,
  schema,
  toDatabaseSchema,
  fromDatabaseSchema,
  lowerMigration,
  encodeMigration,
} from "../src/index.ts";
const model = (sql: string) => Effect.runSync(Effect.flatMap(schema.decode(sql), toDatabaseSchema));
const plan = (before: string, after: string) =>
  Effect.runSync(
    Effect.flatMap(diffDatabases(model(before), model(after)), (diff) =>
      lowerMigration(planDatabaseMigration(diff), model(before), model(after)),
    ),
  );
const render = (before: string, after: string) =>
  Effect.runSync(encodeMigration(plan(before, after)));
const table = "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, active INTEGER);";
const indexes =
  "CREATE UNIQUE INDEX ix_unique ON t(name COLLATE NOCASE) WHERE active=1; CREATE INDEX ix_expr ON t(lower(name) DESC, id);";

test("index codecs and models preserve ordinary, unique, expression and partial definitions", () => {
  const ast = Effect.runSync(schema.decode(indexes + table));
  const dbModel = Effect.runSync(toDatabaseSchema(ast));
  assert.equal(dbModel.tables[0]!.indexes!.length, 2);
  const restored = Effect.runSync(decodeDatabaseSchema(JSON.parse(JSON.stringify(dbModel))));
  const roundtrip = Effect.runSync(toDatabaseSchema(Effect.runSync(fromDatabaseSchema(restored))));
  assert.deepEqual(roundtrip, dbModel);
  for (const source of [
    "CREATE INDEX IF NOT EXISTS main.i ON t(name ASC, id DESC)",
    "CREATE UNIQUE INDEX i ON t(lower(name) COLLATE NOCASE) WHERE active > 0",
  ]) {
    const value = Effect.runSync(createIndex.decode(source));
    assert.deepEqual(
      Effect.runSync(createIndex.decode(Effect.runSync(createIndex.encode(value)))),
      value,
    );
  }
  assert.deepEqual(
    Effect.runSync(
      diffDatabases(
        model(table + "CREATE INDEX i ON t(name ASC)"),
        model(table + "CREATE INDEX i ON t(name)"),
      ),
    ),
    { changes: [] },
  );
  for (const source of [
    "CREATE INDEX i ON t()",
    "CREATE INDEX i ON main.t(name)",
    "CREATE INDEX i ON t(name NULLS LAST)",
    "CREATE TEMP INDEX i ON t(name)",
    "CREATE INDEX i ON t(name) WHERE",
  ])
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(createIndex.decode(source)))), source);
});

test("index-only changes avoid table rebuilds and reordering indexes is not a change", () => {
  const after = table + indexes;
  assert.deepEqual(
    plan(table, after).operations.map((op) => op._tag),
    ["CreateIndex", "CreateIndex"],
  );
  assert.deepEqual(
    plan(after, table).operations.map((op) => op._tag),
    ["DropIndex", "DropIndex"],
  );
  assert.deepEqual(
    plan(
      table + "CREATE INDEX i ON t(name)",
      table + "CREATE UNIQUE INDEX i ON t(name DESC) WHERE active=1",
    ).operations.map((op) => op._tag),
    ["DropIndex", "CreateIndex"],
  );
  const reversed =
    table +
    "CREATE INDEX ix_expr ON t(lower(name) DESC,id); CREATE UNIQUE INDEX ix_unique ON t(name COLLATE NOCASE) WHERE active=1;";
  assert.equal(plan(after, reversed).operations.length, 0);
});

test("rebuilds recreate every modeled index and preserve data and uniqueness behavior", () => {
  const before = table + indexes;
  const after = table.replace("name TEXT", "name TEXT NOT NULL") + indexes;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(before + "INSERT INTO t VALUES(1,'One',1),(2,'one',0)");
    db.exec(render(before, after));
    assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()!.n, 2);
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL")
        .get()!.n,
      2,
    );
    assert.match(
      JSON.stringify(
        db.prepare("EXPLAIN QUERY PLAN SELECT * FROM t WHERE lower(name)='one'").all(),
      ),
      /ix_expr/,
    );
    assert.throws(() => db.exec("INSERT INTO t VALUES(3,'ONE',1)"), /UNIQUE/);
    db.exec("INSERT INTO t VALUES(3,'ONE',0)");
  } finally {
    db.close();
  }
});

test("index-only migrations execute changes without changing table storage", () => {
  const before = table + "CREATE INDEX i ON t(name)",
    after = table + "CREATE UNIQUE INDEX i ON t(lower(name)) WHERE active=1";
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(before + "; INSERT INTO t VALUES(1,'Ada',1)");
    const root = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='t'").get()!.rootpage;
    db.exec(render(before, after));
    assert.equal(
      db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='t'").get()!.rootpage,
      root,
    );
    assert.throws(() => db.exec("INSERT INTO t VALUES(2,'ADA',1)"), /UNIQUE/);
    db.exec(render(after, table));
    db.exec("INSERT INTO t VALUES(2,'ADA',1)");
    assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_index_list('t')").get()!.n, 0);
  } finally {
    db.close();
  }
});

test("renamed columns and changed index expressions use the desired definitions", () => {
  const beforeSql = table + indexes,
    afterSql = (table + indexes).replaceAll("name", "title");
  const before = model(beforeSql),
    after = model(afterSql);
  const pending = Effect.runSync(prepareMigrationDecisions(before, after));
  const resolved = Effect.runSync(
    resolveMigrationDecisions(before, after, {
      ...pending,
      decisions: pending.decisions.map((item) => ({
        ...item,
        resolution: { action: "rename", target: "title" },
      })),
    }),
  );
  const sql = Effect.runSync(
    Effect.flatMap(
      lowerMigration(planDatabaseMigration(resolved.diff), before, after),
      encodeMigration,
    ),
  );
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(beforeSql + "INSERT INTO t VALUES(1,'kept',1)");
    db.exec(sql);
    assert.equal(
      db.prepare("SELECT title FROM t INDEXED BY ix_unique WHERE active=1").get()!.title,
      "kept",
    );
  } finally {
    db.close();
  }
});

test("unknown/missing indexes, views and triggers block a rebuild before dropping objects", () => {
  const before = table + indexes,
    after = table.replace("name TEXT", "name TEXT NOT NULL") + indexes;
  for (const extra of [
    "CREATE INDEX surprise ON t(active)",
    "DROP INDEX ix_expr",
    "CREATE VIEW v AS SELECT * FROM t",
    "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
  ]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(before + "INSERT INTO t VALUES(1,'kept',1);" + extra);
      assert.throws(() => db.exec(render(before, after)), /CHECK/);
      assert.equal(db.prepare("SELECT name FROM t").get()!.name, "kept");
    } finally {
      db.close();
    }
  }
});

test("unique-index creation failure can roll back a rebuild including original indexes", () => {
  const before = table + "CREATE INDEX i ON t(name)",
    after = table.replace("name TEXT", "name TEXT NOT NULL") + "CREATE UNIQUE INDEX i ON t(name)";
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(before + "; INSERT INTO t VALUES(1,'same',1),(2,'same',1)");
    assert.throws(() => db.exec(render(before, after)), /UNIQUE/);
    // Standalone-script callers must roll back on any SQL error; the driver does this automatically.
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()!.n, 2);
    assert.equal(
      db.prepare("SELECT [unique] FROM pragma_index_list('t') WHERE name='i'").get()!.unique,
      0,
    );
  } finally {
    db.close();
  }
});

test("schema-level index names, target tables and temporary table resolution are validated", () => {
  for (const source of [
    "CREATE INDEX i ON missing(x)",
    table + "CREATE INDEX t ON t(name)",
    table + "CREATE INDEX i ON t(name); CREATE INDEX I ON t(active)",
    table + "CREATE INDEX sqlite_bad ON t(name)",
  ])
    assert.ok(
      Result.isFailure(
        Effect.runSync(Effect.result(Effect.flatMap(schema.decode(source), toDatabaseSchema))),
      ),
      source,
    );
  const resolved = model("CREATE TABLE t(a); CREATE TEMP TABLE t(a); CREATE INDEX i ON t(a)");
  assert.equal(resolved.tables.find((t) => t.identity.catalog === "temp")!.indexes!.length, 1);
  assert.equal(resolved.tables.find((t) => t.identity.catalog === "main")!.indexes, undefined);
});

const root = new URL("./fixtures/previous/indexed-column/", import.meta.url);
for (const category of readdirSync(root))
  for (const file of readdirSync(new URL(category + "/", root)))
    test(`previous indexed-column/${category}/${file}`, () => {
      const source = readFileSync(new URL(category + "/" + file, root), "utf8");
      const result = Effect.runSync(
        Effect.result(createIndex.decode(`CREATE INDEX i ON t(${source})`)),
      );
      // The old edge fixture uses reserved SELECT as an unquoted collation name.
      if (category === "invalid" || category === "edge") assert.ok(Result.isFailure(result));
      else {
        assert.ok(Result.isSuccess(result));
        assert.deepEqual(
          Effect.runSync(createIndex.decode(Effect.runSync(createIndex.encode(result.success)))),
          result.success,
        );
      }
    });
