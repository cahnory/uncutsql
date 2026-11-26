import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
      encoding: "utf8",
      input,
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
  assert.match(help.stdout, /USAGE/);
  assert.match(help.stdout, /uncutsql <subcommand> \[flags\]/);
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
    for (const args of [["diff"], ["diff", "-", "-"], ["diff", before, after, "extra"]]) {
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
    assert.equal(drop.status, 1);
    assert.equal(drop.stdout, "");
    assert.match(drop.stderr, /Unresolved migration decisions/);
    const pending = JSON.parse(run(["decisions", before, "-"], "").stdout);
    const choices = join(directory, "choices.json");
    writeFileSync(
      choices,
      JSON.stringify({
        ...pending,
        decisions: pending.decisions.map((item: object) => ({
          ...item,
          resolution: { action: "drop" },
        })),
      }),
    );
    const approved = run(["migration", before, "-", "--decisions", choices], "");
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /WARNING: Dropping table/);
    assert.match(approved.stdout, /DROP TABLE "main"\."t";/);
    assert.equal(run(["migration", before, "-"], "CREATE TABLE t (a)").stdout, "");
    assert.equal(run(["migration", "-", "-"]).status, 2);
    assert.equal(readFileSync(before, "utf8"), "CREATE TABLE t (a)");
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("configured multipart schemas use config-relative paths and retain part diagnostics", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-parts-"));
  try {
    mkdirSync(join(cwd, "project/schema/nested"), { recursive: true });
    writeFileSync(
      join(cwd, "project/settings.json"),
      JSON.stringify({ migrations: "history", schema: "schema" }),
    );
    const put = (name: string, sql: string) =>
      writeFileSync(join(cwd, "project/schema", name), sql);
    const invoke = (...args: string[]) =>
      run(["--config", "project/settings.json", ...args], "", cwd);
    assert.match(invoke("generate").stderr, /no \*\.uncut\.sql/);
    put("nested/t.uncut.sql", "CREATE TABLE t (id) -- no terminator");
    put("index.uncut.sql", "CREATE INDEX idx ON t(id)");
    put("ignored.sql", "invalid");
    const generated = invoke("generate");
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(readFileSync(join(cwd, "project/history/000001.sql"), "utf8"), /CREATE INDEX/);
    assert.deepEqual(JSON.parse(invoke("diff").stdout), { changes: [] });
    put("nested/t.uncut.sql", "CREATE TABLE t (id, name TEXT)");
    assert.match(invoke("diff").stdout, /ColumnAdded/);
    const applied = invoke("apply", "db.sqlite");
    assert.equal(applied.status, 0, applied.stderr);
    put("nested/t.uncut.sql", "-- line one\ninvalid");
    const invalid = invoke("format");
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /t\.uncut\.sql:2:1/);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("project diff uses the lock, discovers config, and never generates output", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-project-diff-"));
  try {
    const schema = join(cwd, "schema.sql");
    writeFileSync(schema, "CREATE TABLE t (id)");
    writeFileSync(
      join(cwd, "uncutsql.config.json"),
      JSON.stringify({
        migrations: "history",
        schema: "schema.sql",
      }),
    );
    const initial = run([], "", cwd);
    assert.equal(initial.status, 0, initial.stderr);
    assert.match(initial.stdout, /TableAdded/);
    assert.throws(() => readFileSync(join(cwd, "history/uncutsql.lock.json")));
    const generated = run(["generate"], "", cwd);
    assert.equal(generated.status, 0, generated.stderr);
    const lock = readFileSync(join(cwd, "history/uncutsql.lock.json"), "utf8");
    assert.deepEqual(JSON.parse(run(["diff"], "", cwd).stdout), { changes: [] });
    writeFileSync(schema, "CREATE TABLE t (id, name TEXT)");
    const changed = run(["--config", "uncutsql.config.json"], "", cwd);
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.stdout, /ColumnAdded/);
    writeFileSync(join(cwd, "override.sql"), "CREATE TABLE t (id)");
    const overridden = run(
      ["diff", "--schema", "override.sql", "--migrations", "history"],
      "",
      cwd,
    );
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.deepEqual(JSON.parse(overridden.stdout), { changes: [] });
    assert.match(
      run(["diff", "schema.sql", "--schema", "override.sql"], "", cwd).stdout,
      /ColumnAdded/,
    );
    assert.equal(readFileSync(join(cwd, "history/uncutsql.lock.json"), "utf8"), lock);
    writeFileSync(join(cwd, "history/000001.sql"), "tampered");
    assert.match(run(["diff"], "", cwd).stderr, /migration hash/);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("shared flags accept inline or separate values before or after the command", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-flags-"));
  try {
    writeFileSync(join(cwd, "schema=v1.sql"), "create table t (a)");
    for (const args of [
      ["--schema=schema=v1.sql", "format"],
      ["format", "--schema", "schema=v1.sql"],
      ["format", "--", "schema=v1.sql"],
    ]) {
      const result = run(args, "", cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'CREATE TABLE "t" ("a");\n');
      assert.equal(result.stderr, "");
    }
    const literal = run(["format", "--", "--schema=schema=v1.sql"], "", cwd);
    assert.equal(literal.status, 2);
    assert.equal(literal.stdout, "");
    assert.match(literal.stderr, /Usage:/);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("duplicate flags and competing stdin consumers produce usage diagnostics", () => {
  for (const [args, diagnostic] of [
    [["--schema=a.sql", "format", "--schema", "b.sql"], /--schema was specified more than once/],
    [["generate", "--write-decisions", "--write-decisions=b.json"], /Choose only one/],
    [["generate", "--interactive", "--schema=-"], /reads answers from stdin/],
    [["diff", "-", "-"], /at most one may be stdin/],
  ] as const) {
    const result = run([...args], "invalid SQL");
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, diagnostic);
    assert.match(result.stderr, /Usage:/);
  }
});
