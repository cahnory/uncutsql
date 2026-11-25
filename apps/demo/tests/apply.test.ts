import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { applyGenerated, hashMigration } from "@uncutsql/cli";
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

test("verify checks applied files while apply reads pending files and checks live drift", () => {
  const cwd = directory();
  try {
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (a)").status, 0);
    assert.equal(run(cwd, ["apply", "app.sqlite"]).status, 0);
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (a, b)").status, 0);
    const first = join(cwd, "migrations", "000001.sql");
    const original = readFileSync(first, "utf8");
    writeFileSync(first, `${original}\n-- edited`);
    const edited = run(cwd, ["verify"]);
    assert.equal(edited.status, 1);
    assert.match(edited.stderr, /000002.sql: parent hash/);
    const fresh = run(cwd, ["apply", "fresh.sqlite"]);
    assert.equal(fresh.status, 1);
    assert.equal(existsSync(join(cwd, "fresh.sqlite")), false);
    rmSync(first);
    const incremental = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(incremental.status, 0, incremental.stderr);
    writeFileSync(first, original);
    assert.equal(run(cwd, ["verify"]).status, 0);
    exec(join(cwd, "app.sqlite"), "ALTER TABLE t ADD COLUMN unexpected TEXT");
    const drift = run(cwd, ["apply", "app.sqlite"]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /last applied snapshot/);
    assert.equal(
      rows(join(cwd, "app.sqlite"), "SELECT count(*) AS n FROM __uncutsql_migrations")[0]!.n,
      2,
    );
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("apply checks a database checkpoint even when there are no pending files", () => {
  const cwd = directory();
  try {
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (a)").status, 0);
    assert.equal(run(cwd, ["apply", "db"]).status, 0);
    const path = join(cwd, "migrations", "000001.sql");
    const lockPath = join(cwd, "migrations", "uncutsql.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, JSON.stringify({ ...lock, database: { tables: [] } }));
    assert.match(run(cwd, ["verify"]).stderr, /schema snapshot/);
    rmSync(path);
    writeFileSync(lockPath, JSON.stringify(lock));
    const noop = run(cwd, ["apply", "db"]);
    assert.equal(noop.status, 0, noop.stderr);
    assert.match(noop.stdout, /up to date/);
    writeFileSync(lockPath, JSON.stringify({ ...lock, lastMigrationSha256: "0".repeat(64) }));
    assert.match(run(cwd, ["apply", "db"]).stderr, /checkpoint does not match/);
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
    checkpoint: () => Effect.succeed({ id: 0, sha256: null }),
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

test("down guards data, restores one applied snapshot and allows reapplication", () => {
  const cwd = directory();
  try {
    const database = join(cwd, "db.sqlite");
    const command = (args: string[], input = "") => {
      const result = run(cwd, args, input);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    command(["generate", "-"], "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    command(["generate", "-"], "CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)");
    command(["up", database]);
    command(["generate", "-"], "CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT, name TEXT)");
    exec(database, "INSERT INTO t VALUES (4, 'saved')");
    const down = ["down", database];
    assert.match(run(cwd, down).stderr, /contains data/);
    assert.deepEqual(rows(database, "SELECT * FROM t"), [{ email: "saved", id: 4 }]);
    assert.deepEqual(rows(database, "SELECT id FROM __uncutsql_migrations ORDER BY id"), [
      { id: 1 },
      { id: 2 },
    ]);
    exec(database, "UPDATE t SET email=NULL");
    assert.match(command(down), /Rolled back 000002.sql/);
    assert.deepEqual(rows(database, "SELECT * FROM t"), [{ id: 4 }]);
    assert.match(run(cwd, down).stderr, /contains data/);
    exec(database, "DELETE FROM t");
    assert.match(command(down), /Rolled back 000001.sql/);
    assert.equal(command(down), "No applied migrations.\n");
    assert.match(command(["up", database]), /Applied 000001.sql, 000002.sql, 000003.sql/);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("unlinked migrations are rejected and irreversible migrations retain their history", () => {
  const cwd = directory();
  const db = join(cwd, "db.sqlite");
  try {
    const path = join(cwd, "migrations", "000001.sql");
    const lock = join(cwd, "migrations", "uncutsql.lock.json");
    const oldSql = "BEGIN;\nCREATE TABLE t (id INTEGER);\nCOMMIT;\n";
    assert.equal(run(cwd, ["generate", "-"], "CREATE TABLE t (id INTEGER)").status, 0);
    const original = readFileSync(path, "utf8");
    const originalLock = readFileSync(lock, "utf8");
    writeFileSync(path, oldSql);
    writeFileSync(
      lock,
      JSON.stringify({
        ...JSON.parse(readFileSync(lock, "utf8")),
        lastMigrationSha256: hashMigration(oldSql),
      }),
    );
    const up = run(cwd, ["up", db]);
    assert.equal(up.status, 1);
    assert.match(up.stderr, /chain header/);
    writeFileSync(path, original);
    writeFileSync(lock, originalLock);
    assert.equal(run(cwd, ["up", db]).status, 0);
    const generate = run(cwd, ["generate", "-"], "CREATE TABLE t (id TEXT)");
    assert.equal(generate.status, 0, generate.stderr);
    const apply = run(cwd, ["apply", db]);
    assert.equal(apply.status, 0, apply.stderr);
    const refused = run(cwd, ["down", db]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /changed the type of t.id/);
    assert.deepEqual(rows(db, "SELECT id FROM __uncutsql_migrations ORDER BY id"), [
      { id: 1 },
      { id: 2 },
    ]);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("compact confirms deletion, preserves checkpoints and supports later compaction", () => {
  const cwd = directory();
  const ok = (args: string[], input = "") => {
    const result = run(cwd, args, input);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  try {
    const migrations = join(cwd, "migrations");
    ok(["generate", "-"], "CREATE TABLE t(a)");
    ok(["apply", "behind"]);
    ok(["generate", "-"], "CREATE TABLE t(a,b)");
    ok(["apply", "existing"]);
    exec(join(cwd, "existing"), "INSERT INTO t VALUES(1,2)");
    ok(["generate", "-"], "CREATE TABLE t(a,b,c)");
    const suffix = readFileSync(join(migrations, "000003.sql"));
    for (const input of ["n\n", "\n", ""]) {
      const preview = ok(["compact", "2"], input);
      assert.match(preview.stdout, /cancelled/);
      assert.match(preview.stderr, /Delete +migrations[/\\]000001.sql/);
      assert.match(preview.stderr, /Delete +migrations[/\\]000002.sql/);
      assert.match(preview.stderr, /Create +migrations[/\\]baseline-000002.sql/);
      assert.doesNotMatch(preview.stderr, /000003.sql/);
      assert.ok(existsSync(join(migrations, "000001.sql")));
    }
    ok(["compact", "2"], "yes\n");
    for (const file of ["000001.sql", "000002.sql"]) {
      assert.ok(!existsSync(join(migrations, file)));
    }
    assert.deepEqual(readFileSync(join(migrations, "000003.sql")), suffix);
    ok(["verify"]);
    assert.match(run(cwd, ["up", "behind"]).stderr, /pre-compaction/);
    ok(["up", "existing"]);
    assert.deepEqual(rows(join(cwd, "existing"), "SELECT * FROM t"), [{ a: 1, b: 2, c: null }]);
    ok(["up", "fresh"]);
    assert.deepEqual(rows(join(cwd, "fresh"), "SELECT id FROM __uncutsql_migrations ORDER BY id"), [
      { id: 2 },
      { id: 3 },
    ]);
    ok(["down", "fresh"]);
    assert.match(run(cwd, ["down", "fresh"]).stderr, /compacted baseline/);
    ok(["up", "fresh"]);
    const preview = ok(["compact", "3"], "n\n");
    assert.match(preview.stderr, /Delete +migrations[/\\]baseline-000002.sql/);
    assert.doesNotMatch(preview.stderr, /Delete +migrations[/\\]000002.sql/);
    ok(["compact", "3", "--yes"]);
    assert.ok(!existsSync(join(migrations, "baseline-000002.sql")));
    ok(["up", "fresh2"]);
    ok(["generate", "-"], "CREATE TABLE t(a,b,c,d)");
    ok(["verify"]);
    ok(["up", "fresh2"]);
    ok(["up", "existing"]);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});
