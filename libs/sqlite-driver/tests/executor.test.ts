import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Effect, Result } from "effect";

import { diffDatabases, planDatabaseMigration } from "@uncutsql/core";
import type { DatabaseSchema, MigrationSource } from "@uncutsql/core";
import { encodeMigration, lowerMigration, schema, toDatabaseSchema } from "@uncutsql/sqlite";

import { applyMigrations, SqliteExecutionError } from "../src/index.ts";

const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");
const source = (id: number, sql: string): MigrationSource => ({ id, sha256: hash(sql), sql });
const model = (sql: string) => Effect.runSync(Effect.flatMap(schema.decode(sql), toDatabaseSchema));
const verify = (actual: DatabaseSchema, expected: DatabaseSchema, stage: "applied" | "desired") =>
  Effect.gen(function* () {
    const diff = yield* diffDatabases(expected, actual);
    if (diff.changes.length) {
      return yield* Effect.fail(new Error(`Schema mismatch: ${stage}`));
    }
  });
const generate = (schemas: readonly string[]) => {
  let previous: DatabaseSchema = { tables: [] };
  const migrations = schemas.map((sql, index) => {
    const next = model(sql);
    const diff = Effect.runSync(diffDatabases(previous, next));
    const plan = Effect.runSync(lowerMigration(planDatabaseMigration(diff), previous, next));
    const rendered = Effect.runSync(encodeMigration(plan));
    previous = next;
    return source(index + 1, rendered);
  });
  return { desired: previous, migrations };
};
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "uncutsql-executor-"));
  return {
    close: () => rmSync(directory, { recursive: true }),
    path: join(directory, "app.sqlite"),
  };
};
const read = (path: string, sql: string) => {
  const database = new DatabaseSync(path);
  try {
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
};
const exec = (path: string, sql: string) => {
  const database = new DatabaseSync(path);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
};

test("executor applies, records and resumes generated rebuilds without rerunning history", async () => {
  const target = fixture();
  const schemas = [
    "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
    "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, email TEXT)",
  ];
  const generated = generate(schemas);
  try {
    assert.deepEqual(
      await Effect.runPromise(
        applyMigrations(target.path, generated.migrations.slice(0, 1), model(schemas[0]!), verify),
      ),
      { appliedIds: [1], lastAppliedId: 1 },
    );
    exec(target.path, "INSERT INTO t VALUES (7, 'Ada')");
    assert.deepEqual(
      await Effect.runPromise(
        applyMigrations(target.path, generated.migrations, generated.desired, verify),
      ),
      { appliedIds: [2], lastAppliedId: 2 },
    );
    assert.deepEqual(read(target.path, "SELECT * FROM t"), [{ email: null, id: 7, name: "Ada" }]);
    const history = read(
      target.path,
      "SELECT id, sha256, database_json, applied_at FROM __uncutsql_migrations ORDER BY id",
    );
    assert.equal(history[1]!.sha256, generated.migrations[1]!.sha256);
    assert.deepEqual(JSON.parse(String(history[1]!.database_json)), generated.desired);
    assert.deepEqual(
      await Effect.runPromise(
        applyMigrations(target.path, generated.migrations, generated.desired, verify),
      ),
      { appliedIds: [], lastAppliedId: 2 },
    );
    assert.deepEqual(
      read(
        target.path,
        "SELECT id, sha256, database_json, applied_at FROM __uncutsql_migrations ORDER BY id",
      ),
      history,
    );
  } finally {
    target.close();
  }
});

test("executor inspects standalone indexes and rolls back failed index recreation", async () => {
  const target = fixture();
  const before = "CREATE TABLE t (name TEXT); CREATE INDEX i ON t(lower(name))";
  const after = "CREATE TABLE t (name TEXT NOT NULL); CREATE UNIQUE INDEX i ON t(lower(name))";
  const generated = generate([before, after]);
  try {
    await Effect.runPromise(
      applyMigrations(target.path, generated.migrations.slice(0, 1), model(before), verify),
    );
    exec(target.path, "INSERT INTO t VALUES ('Ada'), ('ADA')");
    const result = await Effect.runPromise(
      Effect.result(applyMigrations(target.path, generated.migrations, generated.desired, verify)),
    );
    assert.ok(Result.isFailure(result));
    assert.match(result.failure.message, /UNIQUE/);
    assert.equal(read(target.path, "SELECT count(*) AS n FROM t")[0]!.n, 2);
    assert.equal(
      read(target.path, "SELECT [unique] FROM pragma_index_list('t') WHERE name='i'")[0]!.unique,
      0,
    );
    assert.equal(read(target.path, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 1);
    exec(target.path, "DELETE FROM t WHERE name='ADA'");
    await Effect.runPromise(
      applyMigrations(target.path, generated.migrations, generated.desired, verify),
    );
    assert.equal(
      read(target.path, "SELECT [unique] FROM pragma_index_list('t') WHERE name='i'")[0]!.unique,
      1,
    );
    assert.deepEqual(
      await Effect.runPromise(
        applyMigrations(target.path, generated.migrations, generated.desired, verify),
      ),
      { appliedIds: [], lastAppliedId: 2 },
    );
    exec(target.path, "DROP INDEX i; CREATE INDEX i ON t(name)");
    const drift = await Effect.runPromise(
      Effect.result(applyMigrations(target.path, generated.migrations, generated.desired, verify)),
    );
    assert.ok(Result.isFailure(drift));
    assert.match(drift.failure.message, /Schema mismatch: applied/);
  } finally {
    target.close();
  }
});

test("native statement parsing handles Unicode, comments, strings and trigger-body semicolons", async () => {
  const target = fixture();
  const ddl = "CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT DEFAULT 'é;COMMIT; -- text')";
  const sql = `-- COMMIT is a comment\nBEGIN; ${ddl};
    CREATE TEMP TRIGGER tr AFTER INSERT ON main.t BEGIN UPDATE t SET value=value WHERE id=NEW.id; SELECT 1; END;
    INSERT INTO t (id) VALUES (1); DROP TRIGGER temp.tr; COMMIT; -- trailing text\n`;
  try {
    await Effect.runPromise(applyMigrations(target.path, [source(1, sql)], model(ddl), verify));
    assert.equal(read(target.path, "SELECT value FROM t")[0]!.value, "é;COMMIT; -- text");
  } finally {
    target.close();
  }
});

test("failed copies roll back schema and history and permit a retry after data repair", async () => {
  const target = fixture();
  const before = "CREATE TABLE t (a INTEGER)";
  const generated = generate([before, "CREATE TABLE t (a INTEGER UNIQUE ON CONFLICT IGNORE)"]);
  try {
    await Effect.runPromise(
      applyMigrations(target.path, generated.migrations.slice(0, 1), model(before), verify),
    );
    exec(target.path, "INSERT INTO t VALUES (1), (1)");
    const result = await Effect.runPromise(
      Effect.result(applyMigrations(target.path, generated.migrations, generated.desired, verify)),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof SqliteExecutionError);
    assert.match(result.failure.message, /UNIQUE/);
    assert.equal(read(target.path, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 1);
    assert.equal(read(target.path, "SELECT count(*) AS n FROM t")[0]!.n, 2);
    exec(target.path, "DELETE FROM t WHERE rowid=(SELECT max(rowid) FROM t)");
    await Effect.runPromise(
      applyMigrations(target.path, generated.migrations, generated.desired, verify),
    );
    assert.equal(read(target.path, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 2);
  } finally {
    target.close();
  }
});

test("applied checksum changes and live drift are rejected before pending SQL", async () => {
  const target = fixture();
  const before = "CREATE TABLE t (id)";
  const generated = generate([before, "CREATE TABLE t (id, email)"]);
  try {
    await Effect.runPromise(
      applyMigrations(target.path, generated.migrations.slice(0, 1), model(before), verify),
    );
    const changed = [
      source(1, `${generated.migrations[0]!.sql}\n-- edited`),
      generated.migrations[1]!,
    ];
    const checksum = await Effect.runPromise(
      Effect.result(applyMigrations(target.path, changed, generated.desired, verify)),
    );
    assert.ok(Result.isFailure(checksum));
    assert.match(checksum.failure.message, /matching prefix/);
    exec(target.path, "ALTER TABLE t ADD COLUMN rogue TEXT");
    const drift = await Effect.runPromise(
      Effect.result(applyMigrations(target.path, generated.migrations, generated.desired, verify)),
    );
    assert.ok(Result.isFailure(drift));
    assert.match(drift.failure.message, /Schema mismatch: applied/);
    assert.equal(read(target.path, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 1);
    assert.deepEqual(
      read(target.path, "PRAGMA table_info(t)").map((row) => row.name),
      ["id", "rogue"],
    );
  } finally {
    target.close();
  }
});

test("desired-model verification fails before commit and preserves earlier committed files", async () => {
  const target = fixture();
  const files = [
    source(1, "BEGIN; CREATE TABLE t (id); COMMIT;"),
    source(2, "BEGIN; ALTER TABLE t ADD COLUMN wrong TEXT; COMMIT;"),
  ];
  try {
    const result = await Effect.runPromise(
      Effect.result(
        applyMigrations(target.path, files, model("CREATE TABLE t (id, email)"), verify),
      ),
    );
    assert.ok(Result.isFailure(result));
    assert.match(result.failure.message, /Schema mismatch: desired/);
    assert.match(result.failure.message, /migrations 1 were committed/);
    assert.deepEqual(
      read(target.path, "PRAGMA table_info(t)").map((row) => row.name),
      ["id"],
    );
    assert.equal(read(target.path, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 1);
  } finally {
    target.close();
  }
});

for (const sql of [
  "CREATE TABLE t (id);",
  "BEGIN; CREATE TABLE t (id); COMMIT; CREATE TABLE outside (id);",
  "BEGIN; CREATE TABLE t (id); BEGIN; COMMIT;",
  "BEGIN;\vCREATE TABLE t (id); COMMIT;",
  "BEGIN; DROP TABLE __uncutsql_migrations; COMMIT;",
  "BEGIN; PRAGMA writable_schema=ON; CREATE TABLE t (id); COMMIT;",
]) {
  test(`unsupported script envelope cannot commit: ${sql}`, async () => {
    const target = fixture();
    try {
      const result = await Effect.runPromise(
        Effect.result(
          applyMigrations(target.path, [source(1, sql)], model("CREATE TABLE t (id)"), verify),
        ),
      );
      assert.ok(Result.isFailure(result));
      assert.deepEqual(
        read(target.path, "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'"),
        [],
      );
    } finally {
      target.close();
    }
  });
}

test("untracked nonempty databases and non-main targets are not adopted", async () => {
  const target = fixture();
  try {
    exec(target.path, "CREATE TABLE owned (id); INSERT INTO owned VALUES (42)");
    const generated = generate(["CREATE TABLE t (id)"]);
    const result = await Effect.runPromise(
      Effect.result(applyMigrations(target.path, generated.migrations, generated.desired, verify)),
    );
    assert.ok(Result.isFailure(result));
    assert.match(result.failure.message, /nonempty database/);
    assert.deepEqual(read(target.path, "SELECT * FROM owned"), [{ id: 42 }]);
    const other = `${target.path}.other`;
    const unsupported = await Effect.runPromise(
      Effect.result(
        applyMigrations(other, generated.migrations, model("CREATE TEMP TABLE t (id)"), verify),
      ),
    );
    assert.ok(Result.isFailure(unsupported));
    assert.equal(existsSync(other), false);
  } finally {
    target.close();
  }
});

test("foreign-key failures cannot commit schema or an applied-history row", async () => {
  const target = fixture();
  const ddl = "CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p_id REFERENCES p(id))";
  try {
    const result = await Effect.runPromise(
      Effect.result(
        applyMigrations(
          target.path,
          [source(1, `BEGIN; ${ddl}; INSERT INTO c VALUES (99); COMMIT;`)],
          model(ddl),
          verify,
        ),
      ),
    );
    assert.ok(Result.isFailure(result));
    assert.match(result.failure.message, /foreign-key violations/);
    assert.deepEqual(
      read(target.path, "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'"),
      [],
    );
  } finally {
    target.close();
  }
});

test("independent executor processes serialize history and do not apply files twice", async () => {
  const target = fixture();
  const generated = generate([
    "CREATE TABLE t (id INTEGER PRIMARY KEY)",
    "CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)",
  ]);
  const program = `
    import {Effect} from "effect";
    import {diffDatabases} from "@uncutsql/core";
    import {applyMigrations} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    const input = JSON.parse(process.argv[1]);
    await Effect.runPromise(applyMigrations(input.path, input.migrations, input.desired,
      (actual, expected) => Effect.gen(function* () {
        const diff = yield* diffDatabases(expected, actual);
        if (diff.changes.length) return yield* Effect.fail(new Error("schema mismatch"));
      })));
  `;
  const execute = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", program, JSON.stringify({ path: target.path, ...generated })],
        { cwd: fileURLToPath(new URL("../", import.meta.url)) },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });
  try {
    await Promise.all([execute(), execute()]);
    assert.deepEqual(read(target.path, "SELECT id FROM __uncutsql_migrations ORDER BY id"), [
      { id: 1 },
      { id: 2 },
    ]);
    assert.deepEqual(
      read(target.path, "PRAGMA table_info(t)").map((row) => row.name),
      ["id", "email"],
    );
  } finally {
    target.close();
  }
});

test("executor leaves incompatible history tables untouched", async () => {
  const columns =
    "id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, dialect TEXT NOT NULL, format_version INTEGER NOT NULL, database_json TEXT NOT NULL, applied_at TEXT NOT NULL";
  for (const definition of [
    columns.replace(" PRIMARY KEY", ""),
    columns.replace(" NOT NULL", ""),
    columns + ", extra AS (id)",
    columns.replace("sha256 TEXT", "sha256 TEXT DEFAULT 'unknown'"),
  ]) {
    const target = fixture();
    try {
      exec(target.path, `CREATE TABLE __uncutsql_migrations (${definition})`);
      const { desired, migrations } = generate(["CREATE TABLE t (id)"]);
      await assert.rejects(
        Effect.runPromise(applyMigrations(target.path, migrations, desired, verify)),
        /Unrecognized applied-history table format/,
      );
      assert.deepEqual(read(target.path, "SELECT name FROM sqlite_schema"), [
        { name: "__uncutsql_migrations" },
      ]);
      assert.deepEqual(read(target.path, "SELECT * FROM __uncutsql_migrations"), []);
    } finally {
      target.close();
    }
  }
});

test("live view snapshots survive rebuilds and detect drift before the next migration", async () => {
  const target = fixture();
  const view = "; CREATE VIEW v AS SELECT n FROM t";
  const baseline = "CREATE TABLE t(n INT)" + view;
  const rebuilt = "CREATE TABLE t(n INT UNIQUE)" + view;
  const generated = generate([baseline, rebuilt]);
  try {
    await Effect.runPromise(
      applyMigrations(target.path, generated.migrations.slice(0, 1), model(baseline), verify),
    );
    exec(target.path, "INSERT INTO t VALUES (7)");
    await Effect.runPromise(
      applyMigrations(target.path, generated.migrations, generated.desired, verify),
    );
    assert.deepEqual(read(target.path, "SELECT * FROM v"), [{ n: 7 }]);
    exec(target.path, "DROP VIEW v; CREATE VIEW v AS SELECT 99 AS n");
    await assert.rejects(
      Effect.runPromise(
        applyMigrations(target.path, generated.migrations, generated.desired, verify),
      ),
      /Schema mismatch: applied/,
    );
  } finally {
    target.close();
  }
});

test("live schema inspection matches legacy quoted declarations to canonical names", async () => {
  const target = fixture();
  const legacy = `
    CREATE TABLE 'parent' ('it''s id' INTEGER PRIMARY KEY);
    CREATE TABLE 'child' ('key' REFERENCES 'parent' ('it''s id'));
    CREATE INDEX 'child keys' ON 'child' ("key");
    CREATE VIEW 'report' ('display name') AS SELECT 'key' FROM 'child';
  `;
  const desired = model(`
    CREATE TABLE "parent" ("it's id" INTEGER PRIMARY KEY);
    CREATE TABLE "child" ("key" REFERENCES "parent" ("it's id"));
    CREATE INDEX "child keys" ON "child" ("key");
    CREATE VIEW "report" ("display name") AS SELECT 'key' FROM "child";
  `);
  const migration = source(1, `BEGIN; ${legacy} COMMIT;`);
  try {
    await Effect.runPromise(applyMigrations(target.path, [migration], desired, verify));
    exec(target.path, "INSERT INTO parent VALUES (7); INSERT INTO child VALUES (7)");
    assert.deepEqual(read(target.path, "SELECT * FROM report"), [{ "display name": "key" }]);
    const resumed = await Effect.runPromise(
      applyMigrations(target.path, [migration], desired, verify),
    );
    assert.deepEqual(resumed.appliedIds, []);
  } finally {
    target.close();
  }
});
