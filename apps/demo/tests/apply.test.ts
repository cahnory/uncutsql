import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { applyGenerated } from "@uncutsql/cli";
import { generateMigration } from "@uncutsql/cli";
import type { DatabaseSchema, MigrationExecutor } from "@uncutsql/core";
import type { Dialect } from "@uncutsql/core";

const cli = fileURLToPath(import.meta.resolve("@uncutsql/cli/bin"));
const directory = () => mkdtempSync(join(tmpdir(), "uncutsql-apply-"));
const run = (cwd: string, args: string[], input = "") =>
  spawnSync(
    process.execPath,
    [
      cli,
      "--dialect",
      import.meta.resolve("@uncutsql/sqlite"),
      "--driver",
      import.meta.resolve("@uncutsql/sqlite-driver"),
      ...args,
    ],
    { cwd, encoding: "utf8", input },
  );
const exec = (path: string, sql: string) => {
  const database = new DatabaseSync(path);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
};
const rows = (path: string, sql: string) => {
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

test("CLI applies generated migrations and stores application history separately from the lock", () => {
  const cwd = directory();
  try {
    const database = join(cwd, "app.sqlite");
    assert.equal(
      run(cwd, ["generate", "-"], "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").status,
      0,
    );
    const first = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "Applied 000001.sql.\n");
    exec(database, "INSERT INTO t VALUES (7, 'Ada')");
    assert.equal(
      run(
        cwd,
        ["generate", "-"],
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, email TEXT)",
      ).status,
      0,
    );
    const lockPath = join(cwd, "migrations", "uncutsql.lock.json");
    const before = readFileSync(lockPath, "utf8");
    const second = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, "Applied 000002.sql.\n");
    assert.deepEqual(rows(database, "SELECT * FROM t"), [{ email: null, id: 7, name: "Ada" }]);
    assert.equal(rows(database, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 2);
    const noop = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(noop.status, 0, noop.stderr);
    assert.equal(noop.stdout, "Database is up to date.\n");
    assert.equal(readFileSync(lockPath, "utf8"), before);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("CLI failures leave a pending migration unrecorded and can resume after data repair", () => {
  const cwd = directory();
  try {
    const database = join(cwd, "app.sqlite");
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (a INTEGER)").status, 0);
    assert.equal(run(cwd, ["apply", "app.sqlite"]).status, 0);
    exec(database, "INSERT INTO t VALUES (1), (1)");
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (a INTEGER UNIQUE)").status, 0);
    const failure = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /UNIQUE/);
    assert.equal(rows(database, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 1);
    assert.equal(rows(database, "SELECT count(*) AS n FROM t")[0]!.n, 2);
    exec(database, "DELETE FROM t WHERE rowid=(SELECT max(rowid) FROM t)");
    const retry = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(rows(database, "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n, 2);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("CLI detects edited applied files and live schema drift", () => {
  const cwd = directory();
  try {
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (a)").status, 0);
    assert.equal(run(cwd, ["apply", "app.sqlite"]).status, 0);
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (a, b)").status, 0);
    const first = join(cwd, "migrations", "000001.sql");
    const original = readFileSync(first, "utf8");
    writeFileSync(first, `${original}\n-- edited`);
    const edited = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(edited.status, 1);
    assert.match(edited.stderr, /matching prefix/);
    writeFileSync(first, original);
    exec(join(cwd, "app.sqlite"), "ALTER TABLE t ADD COLUMN unexpected TEXT");
    const drift = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /last applied snapshot/);
    assert.equal(
      rows(join(cwd, "app.sqlite"), "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n,
      1,
    );
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("CLI validates history and usage before opening a target database", () => {
  const cwd = directory();
  try {
    for (const args of [
      ["apply"],
      ["apply", "-"],
      ["apply", "db", "--bad"],
      ["apply", "db", "a", "b"],
    ]) {
      assert.equal(run(cwd, args).status, 2);
    }
    const missing = run(cwd, ["apply", "new.sqlite"]);
    assert.equal(missing.status, 1);
    assert.equal(existsSync(join(cwd, "new.sqlite")), false);
    assert.equal(run(cwd, ["generate", "-", "out"], "CREATE TABLE t (id)").status, 0);
    writeFileSync(join(cwd, "out", "000001.sql"), "edited");
    const changed = run(cwd, ["apply", "new.sqlite", "out"]);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /migration hash/);
    assert.equal(existsSync(join(cwd, "new.sqlite")), false);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("application orchestration uses a swappable executor and core-owned verification", async () => {
  const cwd = directory();
  const database: DatabaseSchema = {
    tables: [{ columns: [], constraints: [], identity: { name: "t" }, name: "t", options: {} }],
  };
  const dialect: Dialect<DatabaseSchema, string, never> = {
    encodeMigration: () => Effect.succeed("BEGIN; CREATE THING; COMMIT;"),
    format: () => Effect.succeed(""),
    lowerMigration: () => Effect.succeed("plan"),
    name: "fixture",
    parse: () => Effect.succeed(database),
    toDatabaseSchema: (ast) => Effect.succeed(ast),
  };
  let calls = 0;
  const executor: MigrationExecutor<never> = {
    apply: (target, files, desired, verify) =>
      Effect.gen(function* () {
        assert.equal(target, "opaque-target");
        assert.equal(files.length, 1);
        calls++;
        yield* verify(database, desired, "desired");
        return { appliedIds: [1], lastAppliedId: 1 };
      }),
    dialect: "fixture",
  };
  try {
    await Effect.runPromise(generateMigration(dialect, database, cwd));
    const result = await Effect.runPromise(applyGenerated(executor, "opaque-target", cwd));
    assert.equal(calls, 1);
    assert.deepEqual(result.appliedIds, [1]);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("CLI diffs, generates and applies view-only revisions from the lock", () => {
  const cwd = directory();
  try {
    const before = "CREATE VIEW tally(n) AS VALUES (1)";
    const after = "CREATE VIEW tally(n) AS VALUES (2)";
    writeFileSync(join(cwd, "before.sql"), before);
    writeFileSync(join(cwd, "after.sql"), after);
    const diff = run(cwd, ["diff", "before.sql", "after.sql"]);
    assert.equal(diff.status, 0, diff.stderr);
    assert.equal(JSON.parse(diff.stdout).changes[0]._tag, "ViewChanged");
    for (const schema of [before, after]) {
      const generate = run(cwd, ["generate", "-"], schema);
      assert.equal(generate.status, 0, generate.stderr);
      const apply = run(cwd, ["apply", "app.sqlite"]);
      assert.equal(apply.status, 0, apply.stderr);
    }
    const path = join(cwd, "app.sqlite");
    assert.deepEqual(rows(path, "SELECT * FROM tally"), [{ n: 2 }]);
    exec(path, "DROP VIEW tally");
    const drift = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /ViewRemoved.*tally/);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("demo apply preserves view trigger behavior across a rebuild and detects body drift", () => {
  const cwd = directory();
  const path = join(cwd, "app.sqlite");
  try {
    for (const revision of ["expand", "next"]) {
      const fixture = fileURLToPath(new URL(`../examples/schema-${revision}.sql`, import.meta.url));
      const generate = run(cwd, ["generate", fixture]);
      assert.equal(generate.status, 0, generate.stderr);
      const apply = run(cwd, ["apply", path]);
      assert.equal(apply.status, 0, apply.stderr);
      exec(path, "INSERT INTO users(name) VALUES ('Ada'); DELETE FROM active_users");
    }
    assert.deepEqual(rows(path, "SELECT status FROM users ORDER BY id"), [
      { status: "disabled" },
      { status: "disabled" },
    ]);
    exec(
      path,
      "DROP TRIGGER deactivate_user; CREATE TRIGGER deactivate_user INSTEAD OF DELETE ON active_users BEGIN SELECT 1; END",
    );
    const drift = run(cwd, ["apply", path]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /TriggerChanged.*deactivate_user/);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});
