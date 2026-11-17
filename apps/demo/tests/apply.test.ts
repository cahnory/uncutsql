import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Effect } from "effect";
import type { DatabaseSchema, MigrationExecutor } from "@uncutsql/core";
import { applyGenerated } from "@uncutsql/cli";
import { generateMigration } from "@uncutsql/cli";
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
    { cwd, input, encoding: "utf8" },
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
    assert.deepEqual(rows(database, "SELECT * FROM t"), [{ id: 7, name: "Ada", email: null }]);
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
    ])
      assert.equal(run(cwd, args).status, 2);
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
    tables: [{ identity: { name: "t" }, name: "t", columns: [], constraints: [], options: {} }],
  };
  const dialect: Dialect<DatabaseSchema, string, never> = {
    name: "fixture",
    parse: () => Effect.succeed(database),
    format: () => Effect.succeed(""),
    toDatabaseSchema: (ast) => Effect.succeed(ast),
    lowerMigration: () => Effect.succeed("plan"),
    encodeMigration: () => Effect.succeed("BEGIN; CREATE THING; COMMIT;"),
  };
  let calls = 0;
  const executor: MigrationExecutor<never> = {
    dialect: "fixture",
    apply: (target, files, desired, verify) =>
      Effect.gen(function* () {
        assert.equal(target, "opaque-target");
        assert.equal(files.length, 1);
        calls++;
        yield* verify(database, desired, "desired");
        return { appliedIds: [1], lastAppliedId: 1 };
      }),
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
