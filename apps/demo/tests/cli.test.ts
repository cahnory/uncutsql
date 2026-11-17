import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(import.meta.resolve("@uncutsql/cli/bin"));
const run = (args: string[], input = "", cwd?: string) =>
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
    {
      input,
      encoding: "utf8",
      ...(cwd === undefined ? {} : { cwd }),
    },
  );

test("CLI formats complete stdin atomically and validates without database execution", () => {
  const result = run(["format"], "create table a (x default ';'); create table b (y)");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, 'CREATE TABLE "a" ("x" DEFAULT \';\');\nCREATE TABLE "b" ("y");\n');
  const invalid = run(["format", "-"], "CREATE TABLE a (x);\nCREATE TABLE b (y DEFAULT );");
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /<stdin>:2:\d+: Expected/);
  assert.match(invalid.stderr, /\^/);
  assert.doesNotMatch(invalid.stderr, /at file:/);
  const checked = run(["check"], "CREATE TABLE t (a, a)");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /Valid supported SQL syntax/);
});

test("CLI reads paths relative to the caller and leaves files unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "uncutsql-cli-"));
  try {
    const source = "-- comment\ncreate table t (a)";
    const path = join(directory, "schema with spaces.sql");
    writeFileSync(path, source);
    const result = run(["format", "schema with spaces.sql"], "", directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'CREATE TABLE "t" ("a");\n');
    assert.equal(readFileSync(path, "utf8"), source);
    const missing = run(["check", "missing.sql"], "", directory);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /missing.sql:.*ENOENT/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("CLI handles help, usage errors, empty input and unsupported SQL", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  for (const args of [[], ["unknown"], ["check", "a", "b"], ["format", "--write"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/);
  }
  assert.equal(run(["format"], "; -- empty").stdout, "");
  const empty = run(["check"]);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /Valid supported SQL syntax/);
  const unsupported = run(["check"], "SELECT 1;");
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /<stdin>:1:1/);
});

test("CLI diff reports structured changes and supports one stdin input", () => {
  const directory = mkdtempSync(join(tmpdir(), "uncutsql-diff-"));
  try {
    const before = join(directory, "before.sql");
    const after = join(directory, "after.sql");
    writeFileSync(before, "CREATE TABLE t (a INTEGER)");
    writeFileSync(after, "CREATE TABLE t (a TEXT, b)");
    const result = run(["diff", before, after]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(
      parsed.changes[0].changes.map((change: { _tag: string }) => change._tag),
      ["ColumnChanged", "ColumnAdded"],
    );
    const same = run(["diff", before, "-"], "CREATE TABLE t (a INTEGER)");
    assert.equal(same.status, 0, same.stderr);
    assert.deepEqual(JSON.parse(same.stdout), { changes: [] });
    const invalid = run(["diff", before, "-"], "CREATE TABLE t (a, A)");
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Duplicate column/);
    const malformed = run(["diff", before, "-"], "SELECT 1");
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, "");
    assert.match(malformed.stderr, /<stdin>:1:1/);
    for (const args of [
      ["diff"],
      ["diff", before],
      ["diff", "-", "-"],
      ["diff", before, after, "extra"],
    ]) {
      assert.equal(run(args).status, 2);
    }
    assert.equal(readFileSync(before, "utf8"), "CREATE TABLE t (a INTEGER)");
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("CLI migration emits complete scripts or errors without partial output", () => {
  const directory = mkdtempSync(join(tmpdir(), "uncutsql-migration-"));
  try {
    const before = join(directory, "before.sql");
    writeFileSync(before, "CREATE TABLE t (a)");
    const result = run(["migration", before, "-"], "CREATE TABLE t (a, b TEXT DEFAULT 'new')");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'BEGIN;\nALTER TABLE "main"."t" ADD COLUMN "b" TEXT DEFAULT \'new\';\nCOMMIT;\n',
    );
    const unsupported = run(
      ["migration", before, "-"],
      "CREATE TABLE t (rowid, _rowid_, oid, a TEXT); CREATE TABLE added (x)",
    );
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.stdout, "");
    assert.match(unsupported.stderr, /Cannot preserve rowids/);
    const drop = run(["migration", before, "-"], "");
    assert.equal(drop.status, 0, drop.stderr);
    assert.match(drop.stdout, /WARNING: Dropping table/);
    assert.match(drop.stdout, /DROP TABLE "main"\."t";/);
    assert.equal(run(["migration", before, "-"], "CREATE TABLE t (a)").stdout, "");
    assert.equal(run(["migration", "-", "-"]).status, 2);
    assert.equal(readFileSync(before, "utf8"), "CREATE TABLE t (a)");
  } finally {
    rmSync(directory, { recursive: true });
  }
});
