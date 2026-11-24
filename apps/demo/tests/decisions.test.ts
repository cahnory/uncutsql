import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { MigrationDecisions } from "@uncutsql/core";
const cli = fileURLToPath(import.meta.resolve("@uncutsql/cli/bin"));
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

test("CLI requires reviewable decisions, persists them, and applies renamed data without prompting", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-decisions-"));
  try {
    const before = "CREATE TABLE t(id INTEGER PRIMARY KEY, old TEXT)",
      after = "CREATE TABLE t(id INTEGER PRIMARY KEY, new TEXT NOT NULL)";
    const dbPath = join(cwd, "db.sqlite"),
      decisions = join(cwd, "uncutsql.decisions.json");
    assert.equal(run(cwd, ["generate", "-"], before).status, 0);
    assert.equal(run(cwd, ["apply", dbPath]).status, 0);
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO t VALUES(1,'preserved')");
    db.close();
    const unresolved = run(cwd, ["generate", "-"], after);
    assert.equal(unresolved.status, 1);
    assert.match(unresolved.stderr, /Unresolved migration decisions/);
    assert.equal(existsSync(join(cwd, "migrations", "000002.sql")), false);
    const prepared = run(cwd, ["generate", "-", "--write-decisions"], after);
    assert.equal(prepared.status, 0, prepared.stderr);
    const pending = JSON.parse(readFileSync(decisions, "utf8")) as MigrationDecisions;
    assert.deepEqual(pending.decisions[0]!.candidates, ["new"]);
    assert.equal(pending.decisions[0]!.resolution, null);
    const second = run(cwd, ["generate", "-", "--write-decisions"], after);
    assert.equal(second.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(decisions, "utf8")), pending);
    writeFileSync(
      decisions,
      JSON.stringify({
        ...pending,
        decisions: pending.decisions.map((item) => ({
          ...item,
          resolution: { _tag: "Rename", target: "new" },
        })),
      }),
    );
    const generated = run(cwd, ["generate", "-"], after);
    assert.equal(generated.status, 0, generated.stderr);
    const sql = readFileSync(join(cwd, "migrations", "000002.sql"), "utf8");
    assert.match(sql, /uncutsql-decisions:/);
    assert.match(sql, /"Rename"/);
    const applied = run(cwd, ["apply", dbPath]);
    assert.equal(applied.status, 0, applied.stderr);
    const actual = new DatabaseSync(dbPath);
    try {
      assert.deepEqual({ ...actual.prepare("SELECT * FROM t").get() }, { id: 1, new: "preserved" });
    } finally {
      actual.close();
    }
    const stale = run(cwd, ["generate", "-", "--decisions", decisions], after);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Stale migration decisions/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("migration decision output and explicit drop preserve add-default semantics", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-decisions-files-"));
  try {
    const before = join(cwd, "before.sql"),
      after = join(cwd, "after.sql"),
      choices = join(cwd, "choices.json");
    writeFileSync(before, "CREATE TABLE t(id, old)");
    writeFileSync(after, "CREATE TABLE t(id, new DEFAULT 'fresh')");
    const result = run(cwd, ["decisions", before, after]);
    assert.equal(result.status, 0, result.stderr);
    const pending = JSON.parse(result.stdout) as MigrationDecisions;
    writeFileSync(
      choices,
      JSON.stringify({
        ...pending,
        decisions: pending.decisions.map((item) => ({ ...item, resolution: { _tag: "Drop" } })),
      }),
    );
    const script = run(cwd, ["migration", before, after, "--decisions", choices]);
    assert.equal(script.status, 0, script.stderr);
    assert.match(script.stdout, /removes column data/);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE t(id,old); INSERT INTO t VALUES(1,'lost')");
      db.exec(script.stdout);
      assert.equal(db.prepare("SELECT new FROM t").get()!.new, "fresh");
    } finally {
      db.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("default and configured decision files can be prepared and loaded without path flags", () => {
  for (const configured of [false, true]) {
    const cwd = mkdtempSync(join(tmpdir(), "uncutsql-decision-config-"));
    try {
      mkdirSync(join(cwd, "project"));
      const config = join(cwd, "project/settings.json");
      writeFileSync(config, JSON.stringify(configured ? { decisions: "review.json" } : {}));
      const prefix = ["--config", config];
      const before = join(cwd, "before.sql"),
        after = join(cwd, "after.sql");
      writeFileSync(before, "CREATE TABLE t(old)");
      writeFileSync(after, "CREATE TABLE t(new)");
      const args = [...prefix, "migration", before, after];
      const missing = run(cwd, args);
      assert.equal(missing.status, 1);
      assert.match(
        missing.stderr,
        configured ? /Cannot read decisions/ : /Unresolved migration decisions/,
      );
      const prepared = run(cwd, [...args, "--write-decisions"]);
      assert.equal(prepared.status, 0, prepared.stderr);
      const path = join(cwd, "project", configured ? "review.json" : "uncutsql.decisions.json");
      const pending = JSON.parse(readFileSync(path, "utf8")) as MigrationDecisions;
      assert.equal(run(cwd, [...args, "--write-decisions"]).status, 1);
      writeFileSync(
        path,
        JSON.stringify({
          ...pending,
          decisions: pending.decisions.map((item) => ({
            ...item,
            resolution: { _tag: "Rename", target: "new" },
          })),
        }),
      );
      const rendered = run(cwd, args);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.match(rendered.stdout, /"_tag":"Rename"/);
      writeFileSync(path, "invalid json");
      assert.match(run(cwd, args).stderr, /Cannot read decisions/);
      assert.equal(run(cwd, [...prefix, "format", before]).status, 0);
      const override = join(cwd, "override.json");
      writeFileSync(
        override,
        JSON.stringify({
          ...pending,
          decisions: pending.decisions.map((item) => ({
            ...item,
            resolution: { _tag: "Drop" },
          })),
        }),
      );
      const overridden = run(cwd, [...args, "--decisions", "override.json"]);
      assert.equal(overridden.status, 0, overridden.stderr);
      assert.match(overridden.stdout, /removes column data/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});
