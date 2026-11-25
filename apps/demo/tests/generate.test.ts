import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Effect, Result } from "effect";

import { generateMigration } from "@uncutsql/cli";
import { hashMigration } from "@uncutsql/cli";
import type { DatabaseSchema, Dialect } from "@uncutsql/core";

const cli = fileURLToPath(import.meta.resolve("@uncutsql/cli/bin"));
const run = (cwd: string, sql: string, args = ["generate", "-"]) =>
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
    { cwd, encoding: "utf8", input: sql },
  );
const createDirectory = () => mkdtempSync(join(tmpdir(), "uncutsql-generate-"));
const lockFile = (directory: string) => join(directory, "migrations", "uncutsql.lock.json");
const readLock = (directory: string) => JSON.parse(readFileSync(lockFile(directory), "utf8"));

// The persistence workflow also works with a non-SQLite AST and physical plan.
const model: DatabaseSchema = {
  tables: [{ columns: [], constraints: [], identity: { name: "t" }, name: "t", options: {} }],
};
const adapter = (
  render: () => Effect.Effect<string, Error>,
): Dialect<{ database: DatabaseSchema }, string, Error> => ({
  encodeMigration: render,
  format: () => Effect.succeed(""),
  lowerMigration: () => Effect.succeed("plan"),
  name: "fixture",
  parse: () => Effect.succeed({ database: model }),
  toDatabaseSchema: (ast) => Effect.succeed(ast.database),
});

test("CLI generates from a missing baseline, advances IDs and leaves no-op output untouched", () => {
  const directory = createDirectory();
  try {
    const source = join(directory, "schema.sql");
    writeFileSync(source, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const first = run(directory, "", ["generate", "schema.sql"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Generated migrations\/000001.sql/);
    const firstSql = readFileSync(join(directory, "migrations", "000001.sql"), "utf8");
    const firstLock = readLock(directory);
    assert.equal(firstLock.formatVersion, 1);
    assert.equal(firstLock.dialect, "sqlite");
    assert.equal(firstLock.lastMigrationId, 1);
    assert.equal(firstLock.lastMigrationSha256, hashMigration(firstSql));
    assert.equal(firstLock.database.tables[0].name, "t");
    const second = run(directory, "CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)");
    assert.equal(second.status, 0, second.stderr);
    const secondSql = readFileSync(join(directory, "migrations", "000002.sql"), "utf8");
    assert.match(secondSql, /ADD COLUMN "email" TEXT/);
    assert.equal(readLock(directory).lastMigrationId, 2);
    assert.equal(readFileSync(join(directory, "migrations", "000001.sql"), "utf8"), firstSql);
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(firstSql);
      database.exec("INSERT INTO t VALUES (7)");
      database.exec(secondSql);
      assert.deepEqual({ ...database.prepare("SELECT * FROM t").get() }, { email: null, id: 7 });
    } finally {
      database.close();
    }
    const bytes = readFileSync(lockFile(directory), "utf8");
    utimesSync(lockFile(directory), new Date(1000), new Date(1000));
    const unchanged = run(directory, "create table main.T (ID INTEGER PRIMARY KEY, email TEXT)");
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.stdout, "No schema changes.\n");
    assert.equal(readFileSync(lockFile(directory), "utf8"), bytes);
    assert.equal(statSync(lockFile(directory)).mtimeMs, 1000);
    assert.deepEqual(readdirSync(join(directory, "migrations")).sort(), [
      "000001.sql",
      "000002.sql",
      "uncutsql.lock.json",
    ]);
    assert.equal(readFileSync(source, "utf8"), "CREATE TABLE t (id INTEGER PRIMARY KEY)");
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("CLI rejects corrupt, incompatible and malformed-model locks without rewriting them", () => {
  const directory = createDirectory();
  try {
    assert.equal(run(directory, "CREATE TABLE t (id)").status, 0);
    const original = readLock(directory);
    for (const contents of [
      "not JSON",
      JSON.stringify({ ...original, formatVersion: 99 }),
      JSON.stringify({ ...original, dialect: "other" }),
      JSON.stringify({ ...original, database: { tables: "bad" } }),
    ]) {
      writeFileSync(lockFile(directory), contents);
      const result = run(directory, "CREATE TABLE t (id, extra)");
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(lockFile(directory), "utf8"), contents);
      assert.equal(existsSync(join(directory, "migrations", "000002.sql")), false);
      assert.equal(existsSync(join(directory, "migrations", ".uncutsql-generation.lock")), false);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("missing baselines, edited SQL and interrupted output are detected", () => {
  const directory = createDirectory();
  try {
    const output = join(directory, "migrations");
    mkdirSync(output);
    writeFileSync(join(output, "000001.sql"), "existing migration");
    assert.match(run(directory, "CREATE TABLE t (id)").stderr, /without a lock/);
    rmSync(join(output, "000001.sql"));
    assert.equal(run(directory, "CREATE TABLE t (id)").status, 0);
    const bytes = readFileSync(lockFile(directory), "utf8");
    writeFileSync(join(output, "000001.sql"), "edited");
    assert.match(run(directory, "CREATE TABLE t (id)").stderr, /migration hash/);
    writeFileSync(join(output, "000002.sql"), "orphan");
    assert.match(run(directory, "CREATE TABLE t (id)").stderr, /history does not match/);
    assert.equal(readFileSync(lockFile(directory), "utf8"), bytes);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("planning failures leave the previous migration and baseline unchanged", () => {
  const directory = createDirectory();
  try {
    assert.equal(run(directory, "CREATE TABLE t (a)").status, 0);
    const bytes = readFileSync(lockFile(directory), "utf8");
    const result = run(directory, "CREATE TABLE t (a, rowid, _rowid_, oid UNIQUE)");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Cannot preserve rowids/);
    assert.equal(readFileSync(lockFile(directory), "utf8"), bytes);
    assert.deepEqual(readdirSync(join(directory, "migrations")).sort(), [
      "000001.sql",
      "uncutsql.lock.json",
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("concurrent generation is excluded until publication and cleanup finish", async () => {
  const directory = createDirectory();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const dialect = adapter(() =>
    Effect.promise(async () => {
      enter();
      await gate;
      return "CREATE THING;";
    }),
  );
  const first = Effect.runPromise(generateMigration(dialect, { database: model }, directory));
  try {
    await entered;
    const second = await Effect.runPromise(
      Effect.result(generateMigration(dialect, { database: model }, directory)),
    );
    assert.ok(Result.isFailure(second));
    assert.match(second.failure.message, /Another command/);
    resume();
    await first;
    assert.deepEqual(readdirSync(directory).sort(), ["000001.sql", "uncutsql.lock.json"]);
  } finally {
    resume();
    await first.catch(() => {});
    rmSync(directory, { recursive: true });
  }
});

test("publication never overwrites a migration created by another writer", async () => {
  const directory = createDirectory();
  const dialect = adapter(() =>
    Effect.sync(() => {
      writeFileSync(join(directory, "000001.sql"), "foreign output");
      return "CREATE THING;";
    }),
  );
  try {
    const result = await Effect.runPromise(
      Effect.result(generateMigration(dialect, { database: model }, directory)),
    );
    assert.ok(Result.isFailure(result));
    assert.equal(readFileSync(join(directory, "000001.sql"), "utf8"), "foreign output");
    assert.equal(existsSync(join(directory, "uncutsql.lock.json")), false);
    assert.deepEqual(readdirSync(directory), ["000001.sql"]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("failed lock replacement removes the newly published SQL before returning", async () => {
  const directory = createDirectory();
  const dialect = adapter(() =>
    Effect.sync(() => {
      if (!existsSync(join(directory, "baseline.backup"))) {
        renameSync(join(directory, "uncutsql.lock.json"), join(directory, "baseline.backup"));
        mkdirSync(join(directory, "uncutsql.lock.json"));
      }
      return "ALTER THING;";
    }),
  );
  try {
    const original = adapter(() => Effect.succeed("CREATE THING;"));
    await Effect.runPromise(generateMigration(original, { database: model }, directory));
    const bytes = readFileSync(join(directory, "uncutsql.lock.json"), "utf8");
    const after = { tables: [{ ...model.tables[0]!, options: { "fixture:changed": true } }] };
    const result = await Effect.runPromise(
      Effect.result(generateMigration(dialect, { database: after }, directory)),
    );
    assert.ok(Result.isFailure(result));
    assert.equal(existsSync(join(directory, "000002.sql")), false);
    assert.equal(readFileSync(join(directory, "baseline.backup"), "utf8"), bytes);
    rmdirSync(join(directory, "uncutsql.lock.json"));
    renameSync(join(directory, "baseline.backup"), join(directory, "uncutsql.lock.json"));
    assert.deepEqual(readdirSync(directory).sort(), ["000001.sql", "uncutsql.lock.json"]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("empty dialect output cannot advance the baseline for real changes", async () => {
  const directory = createDirectory();
  try {
    const result = await Effect.runPromise(
      Effect.result(
        generateMigration(
          adapter(() => Effect.succeed(" ")),
          { database: model },
          directory,
        ),
      ),
    );
    assert.ok(Result.isFailure(result));
    assert.match(result.failure.message, /empty SQL/);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("stale writer locks are preserved and generate validates usage and input before writing", () => {
  const directory = createDirectory();
  try {
    assert.equal(run(directory, "SELECT 1", ["generate", "-", "out"]).status, 1);
    assert.equal(existsSync(join(directory, "out")), false);
    for (const args of [["generate"], ["generate", "-", "--bad"], ["generate", "-", "a", "b"]]) {
      assert.equal(run(directory, "", args).status, 2);
    }
    const output = join(directory, "out");
    mkdirSync(output);
    const writer = join(output, ".uncutsql-generation.lock");
    writeFileSync(writer, "interrupted");
    const result = run(directory, "CREATE TABLE t (id)", ["generate", "-", "out"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /interrupted/);
    assert.equal(readFileSync(writer, "utf8"), "interrupted");
  } finally {
    rmSync(directory, { recursive: true });
  }
});
