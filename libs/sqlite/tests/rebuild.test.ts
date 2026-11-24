import { diffSchemas, planMigration } from "./workflow.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { schema, encodeMigration, MigrationPlanError } from "../src/index.ts";

const parse = (sql: string) => Effect.runSync(schema.decode(sql));
const migration = (before: string, after: string) =>
  Effect.runSync(Effect.flatMap(planMigration(parse(before), parse(after)), encodeMigration));
const introspect = (database: DatabaseSync) =>
  parse(
    database
      .prepare(
        "SELECT sql FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.sql)
      .join(";"),
  );
const rollback = (database: DatabaseSync) => {
  try {
    database.exec("ROLLBACK");
  } catch {
    /* A constraint may already have rolled back. */
  }
  database.exec("PRAGMA foreign_keys=ON");
};

test("rebuild migrates the original next-schema example and preserves incoming references", () => {
  const before = readFileSync(new URL("./fixtures/rebuild/schema.sql", import.meta.url), "utf8");
  const after = readFileSync(
    new URL("./fixtures/rebuild/schema-next.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.exec(before);
    database.exec(
      "INSERT INTO users (id, name) VALUES (7, 'Ada'); INSERT INTO posts VALUES (9, 7, 'Post', '2020-01-01')",
    );
    database.exec(migration(before, after));
    assert.deepEqual(
      { ...database.prepare("SELECT * FROM users").get() },
      { id: 7, name: "Ada", email: null, status: "active" },
    );
    assert.equal(database.prepare("SELECT count(*) AS n FROM posts").get()!.n, 1);
    assert.deepEqual(Effect.runSync(diffSchemas(introspect(database), parse(after))), {
      changes: [],
    });
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.throws(
      () => database.exec("INSERT INTO posts VALUES (10, 999, 'bad', '2020-01-01')"),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => database.exec("INSERT INTO posts VALUES (10, 7, '', '2020-01-01')"),
      /CHECK/,
    );
  } finally {
    database.close();
  }
});

test("rebuild preserves hidden rowids, defaults, generated values and removed-column warnings", () => {
  const before = "CREATE TABLE t (a INTEGER, gone TEXT)";
  const after =
    "CREATE TABLE t (fresh TEXT DEFAULT 'new', a INTEGER, doubled INTEGER AS (a * 2) STORED)";
  const planned = Effect.runSync(planMigration(parse(before), parse(after)));
  assert.equal(planned.warnings[0]!.code, "ColumnDataLoss");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(before);
    database.exec("INSERT INTO t (rowid, a, gone) VALUES (42, 3, 'old')");
    database.exec(Effect.runSync(encodeMigration(planned)));
    assert.deepEqual(
      { ...database.prepare("SELECT rowid, * FROM t").get() },
      { rowid: 42, fresh: "new", a: 3, doubled: 6 },
    );
    assert.deepEqual(Effect.runSync(diffSchemas(introspect(database), parse(after))), {
      changes: [],
    });
  } finally {
    database.close();
  }
});

test("AUTOINCREMENT high-water marks survive populated and emptied rebuilds", () => {
  for (const empty of [false, true]) {
    const before = "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)";
    const after = "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)";
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(before.replace("TABLE t", "TABLE T"));
      database.exec("INSERT INTO t VALUES (1, 'kept'), (99, 'deleted'); DELETE FROM t WHERE id=99");
      if (empty) database.exec("DELETE FROM t");
      database.exec(migration(before, after));
      database.exec("INSERT INTO t (name) VALUES ('new')");
      assert.equal(database.prepare("SELECT id FROM t WHERE name='new'").get()!.id, 100);
    } finally {
      database.close();
    }
  }
});

test("constraint copy failures roll back all previous operations without silently ignoring rows", () => {
  const before = "CREATE TABLE t (a INTEGER)";
  const after = "CREATE TABLE added (x); CREATE TABLE t (a INTEGER UNIQUE ON CONFLICT IGNORE)";
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(before);
    database.exec("INSERT INTO t VALUES (1), (1)");
    assert.throws(() => database.exec(migration(before, after)), /UNIQUE/);
    rollback(database);
    assert.deepEqual(Effect.runSync(diffSchemas(introspect(database), parse(before))), {
      changes: [],
    });
    assert.equal(database.prepare("SELECT count(*) AS n FROM t").get()!.n, 2);
  } finally {
    database.close();
  }
});

test("foreign-key validation fails before commit and rolls back orphan-producing changes", () => {
  const before =
    "CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER)";
  const after =
    "CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id))";
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.exec(before);
    database.exec("INSERT INTO c VALUES (1, 99)");
    assert.throws(() => database.exec(migration(before, after)), /CHECK/);
    rollback(database);
    assert.deepEqual(Effect.runSync(diffSchemas(introspect(database), parse(before))), {
      changes: [],
    });
    assert.equal(database.prepare("SELECT p_id FROM c").get()!.p_id, 99);
  } finally {
    database.close();
  }
});

test("rebuild rejects live indexes, triggers and views absent from schema inputs", () => {
  for (const extra of [
    "CREATE INDEX idx ON t(a)",
    "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
    "CREATE VIEW v AS SELECT * FROM t",
    "CREATE TEMP VIEW v AS SELECT * FROM main.t",
    "CREATE TEMP TRIGGER tr AFTER INSERT ON main.t BEGIN SELECT 1; END",
  ]) {
    const before = "CREATE TABLE t (a INTEGER)";
    const after = "CREATE TABLE t (a TEXT)";
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(before);
      database.exec(extra);
      const objects = () =>
        database
          .prepare("SELECT * FROM main.sqlite_schema UNION ALL SELECT * FROM temp.sqlite_schema")
          .all();
      const snapshot = objects();
      assert.throws(() => database.exec(migration(before, after)), /CHECK/);
      rollback(database);
      assert.deepEqual(objects(), snapshot);
    } finally {
      database.close();
    }
  }
});

test("rebuild handles WITHOUT ROWID, attached and temporary schemas, with reserved-name collisions", () => {
  const before =
    "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT) WITHOUT ROWID; CREATE TABLE __uncutsql_rebuild (x); CREATE TEMP TABLE __uncutsql_migration_guard (x); CREATE TABLE aux.t (id INTEGER PRIMARY KEY, a TEXT); CREATE TEMP TABLE t (id INTEGER PRIMARY KEY, a TEXT)";
  const after = before.replaceAll("a TEXT", "a TEXT UNIQUE");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("ATTACH ':memory:' AS aux");
    database.exec(before);
    database.exec(
      "INSERT INTO main.t VALUES (1, 'main'); INSERT INTO aux.t VALUES (2, 'aux'); INSERT INTO temp.t VALUES (3, 'temp')",
    );
    database.exec(migration(before, after));
    assert.equal(database.prepare("SELECT a FROM main.t").get()!.a, "main");
    assert.equal(database.prepare("SELECT a FROM aux.t").get()!.a, "aux");
    assert.equal(database.prepare("SELECT a FROM temp.t").get()!.a, "temp");
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS n FROM temp.sqlite_schema WHERE name='__uncutsql_migration_guard'",
        )
        .get()!.n,
      1,
    );
  } finally {
    database.close();
  }
});

test("ambiguous rowid copying fails planning", () => {
  const result = Effect.runSync(
    Effect.result(
      planMigration(
        parse("CREATE TABLE t (a)"),
        parse("CREATE TABLE t (a, rowid, _rowid_, oid UNIQUE)"),
      ),
    ),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof MigrationPlanError);
  assert.equal(result.failure.diagnostics[0]!.code, "UnsupportedRowCopy");
});

test("ordinary values cannot be silently replaced by a same-name generated column", () => {
  for (const storage of ["VIRTUAL", "STORED"]) {
    assert.throws(
      () => migration("CREATE TABLE t(a, b)", `CREATE TABLE t(a, B AS (a + 1) ${storage})`),
      /Cannot copy.*b.*generated column.*B/,
    );
  }
});

test("rebuild preserves distinct rowids and rejects competing integer primary key copies", () => {
  const before = "CREATE TABLE t (id INTEGER, value TEXT)";
  for (const after of [
    "CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)",
    'CREATE TABLE t (id "integer", value TEXT, PRIMARY KEY (ID DESC))',
  ])
    assert.throws(() => migration(before, after), /Cannot preserve both the rowid and column/);

  const db = new DatabaseSync(":memory:");
  try {
    db.exec(before);
    db.exec("INSERT INTO t(rowid, id, value) VALUES (42, 7, 'kept')");
    db.exec(migration(before, "CREATE TABLE t (id INTEGER PRIMARY KEY DESC, value TEXT)"));
    assert.deepEqual({ ...db.prepare("SELECT rowid, id FROM t").get() }, { rowid: 42, id: 7 });
  } finally {
    db.close();
  }
});
