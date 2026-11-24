import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
    { cwd, encoding: "utf8", input },
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
    const pending = JSON.parse(readFileSync(decisions, "utf8")) as MigrationDecisions & {
      $schema: string;
    };
    assert.equal(pending.$schema, "./node_modules/@uncutsql/cli/schemas/decisions.schema.json");
    assert.deepEqual(pending.decisions[0]!.candidates, ["new"]);
    assert.deepEqual(pending.decisions[0]!.resolution, { action: "pending" });
    const second = run(cwd, ["generate", "-", "--write-decisions"], after);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /--merge-decisions/);
    assert.match(second.stderr, /--rewrite-decisions/);
    assert.deepEqual(JSON.parse(readFileSync(decisions, "utf8")), pending);
    writeFileSync(
      decisions,
      JSON.stringify({
        ...pending,
        decisions: pending.decisions.map((item) => ({
          ...item,
          resolution: { action: "rename", target: "new" },
        })),
      }),
    );
    const generated = run(cwd, ["generate", "-"], after);
    assert.equal(generated.status, 0, generated.stderr);
    const sql = readFileSync(join(cwd, "migrations", "000002.sql"), "utf8");
    assert.match(sql, /uncutsql-decisions:/);
    assert.match(sql, /"action":"rename"/);
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
    rmSync(cwd, { force: true, recursive: true });
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
    const pending = JSON.parse(result.stdout) as MigrationDecisions & { $schema: string };
    assert.equal(pending.$schema, "./node_modules/@uncutsql/cli/schemas/decisions.schema.json");
    writeFileSync(
      choices,
      JSON.stringify({
        ...pending,
        decisions: pending.decisions.map((item) => ({ ...item, resolution: { action: "drop" } })),
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
    rmSync(cwd, { force: true, recursive: true });
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
      const pending = JSON.parse(readFileSync(path, "utf8")) as MigrationDecisions & {
        $schema: string;
      };
      assert.equal(pending.$schema, "../node_modules/@uncutsql/cli/schemas/decisions.schema.json");
      assert.equal(run(cwd, [...args, "--write-decisions"]).status, 1);
      for (const flag of ["--merge-decisions", "--rewrite-decisions"]) {
        const refreshed = run(cwd, [...args, flag]);
        assert.equal(refreshed.status, 0, refreshed.stderr);
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), pending);
      }
      writeFileSync(
        path,
        JSON.stringify({
          ...pending,
          decisions: pending.decisions.map((item) => ({
            ...item,
            resolution: { action: "rename", target: "new" },
          })),
        }),
      );
      const rendered = run(cwd, args);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.match(rendered.stdout, /"action":"rename"/);
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
            resolution: { action: "drop" },
          })),
        }),
      );
      const overridden = run(cwd, [...args, "--decisions", "override.json"]);
      assert.equal(overridden.status, 0, overridden.stderr);
      assert.match(overridden.stdout, /removes column data/);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  }
});

test("decision schema paths use the nearest installed package for nested output files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-decision-schema-"));
  try {
    const project = join(cwd, "project");
    const schema = join(project, "node_modules/@uncutsql/cli/schemas");
    mkdirSync(schema, { recursive: true });
    writeFileSync(join(schema, "decisions.schema.json"), "{}");
    mkdirSync(join(project, "review"));
    writeFileSync(join(cwd, "before.sql"), "CREATE TABLE t(old)");
    writeFileSync(join(cwd, "after.sql"), "CREATE TABLE t(new)");
    const result = run(cwd, [
      "migration",
      "before.sql",
      "after.sql",
      "--write-decisions",
      "project/review/choices.json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const pending = JSON.parse(readFileSync(join(project, "review/choices.json"), "utf8"));
    assert.equal(pending.$schema, "../node_modules/@uncutsql/cli/schemas/decisions.schema.json");
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("guarded drops check live data and can retry the same migration after rollback", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-guarded-drops-"));
  try {
    const before = 'CREATE TABLE t(id, "old value"); CREATE TABLE obsolete(value)';
    const after = "CREATE TABLE t(id)";
    const path = join(cwd, "db.sqlite");
    const generate = (sql: string, ...args: string[]) => {
      const result = run(cwd, ["generate", "-", ...args], sql);
      assert.equal(result.status, 0, result.stderr);
    };
    generate(before);
    const initial = run(cwd, ["apply", path]);
    assert.equal(initial.status, 0, initial.stderr);
    generate(after, "--write-decisions");
    const file = join(cwd, "uncutsql.decisions.json");
    const choices = JSON.parse(readFileSync(file, "utf8")) as MigrationDecisions;
    for (const choice of choices.decisions) {
      assert.doesNotMatch(choice.question, /rename/i);
    }
    writeFileSync(
      file,
      JSON.stringify({
        ...choices,
        decisions: choices.decisions.map((choice) => ({
          ...choice,
          resolution: { action: "drop_if_empty" },
        })),
      }),
    );
    generate(after);
    const db = new DatabaseSync(path);
    try {
      db.exec("INSERT INTO obsolete VALUES(NULL)");
      const blocked = (target: RegExp) => {
        const result = run(cwd, ["apply", path]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, target);
        assert.equal(db.prepare("SELECT count(*) AS n FROM __uncutsql_migrations").get()!.n, 1);
      };
      blocked(/drop_if_empty.*obsolete/);
      db.exec("DELETE FROM obsolete; INSERT INTO t VALUES(1, '')");
      blocked(/drop_if_empty.*old value/);
      db.exec('UPDATE t SET "old value" = 0');
      blocked(/drop_if_empty.*old value/);
      assert.equal(db.prepare('SELECT "old value" AS v FROM t').get()!.v, 0);
      db.exec('UPDATE t SET "old value" = NULL');
      const applied = run(cwd, ["apply", path]);
      assert.equal(applied.status, 0, applied.stderr);
      assert.deepEqual({ ...db.prepare("SELECT * FROM t").get() }, { id: 1 });
      assert.throws(() => db.prepare("SELECT * FROM obsolete"), /no such table/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("merge refreshes a changed review and rewrite resets its answers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-refresh-decisions-"));
  try {
    const file = join(cwd, "review.json");
    const read = () => JSON.parse(readFileSync(file, "utf8")) as MigrationDecisions;
    const generate = (schema: string, ...flags: string[]) =>
      run(cwd, ["generate", "-", ...flags], schema);
    const before = "CREATE TABLE t(id, a, b, c, d, e); CREATE TABLE obsolete(id)";
    const first = "CREATE TABLE t(id, e, x, y)";
    const next = "CREATE TABLE t(id, d, x, z)";
    assert.equal(generate(before).status, 0);
    const written = generate(first, "--write-decisions=review.json");
    assert.equal(written.status, 0, written.stderr);
    const initial = read();
    writeFileSync(
      file,
      JSON.stringify({
        ...initial,
        decisions: initial.decisions.map((item) => ({
          ...item,
          resolution:
            item.column === "a"
              ? { action: "rename", target: "x" }
              : item.column === "b"
                ? { action: "rename", target: "y" }
                : { action: item.column ? "drop" : "drop_if_empty" },
        })),
      }),
    );
    const merged = generate(next, "--merge-decisions", "review.json");
    assert.equal(merged.status, 0, merged.stderr);
    const review = read();
    assert.deepEqual(
      Object.fromEntries(
        review.decisions.map((item) => [item.column ?? item.table.name, item.resolution]),
      ),
      {
        a: { action: "rename", target: "x" },
        b: { action: "pending" },
        c: { action: "drop" },
        e: { action: "pending" },
        obsolete: { action: "drop_if_empty" },
      },
    );
    assert.deepEqual(review.decisions.find((item) => item.column === "a")!.candidates, ["x", "z"]);
    assert.equal(existsSync(join(cwd, "migrations/000002.sql")), false);
    assert.match(generate(next, "--decisions", "review.json").stderr, /Unresolved decision/);
    const reset = generate(next, "--rewrite-decisions=review.json");
    assert.equal(reset.status, 0, reset.stderr);
    assert.deepEqual(read(), {
      ...review,
      decisions: review.decisions.map((item) => ({ ...item, resolution: { action: "pending" } })),
    });
    writeFileSync(file, "broken");
    assert.equal(generate(next, "--merge-decisions=review.json").status, 1);
    assert.equal(readFileSync(file, "utf8"), "broken");
    assert.equal(generate(next, "--rewrite-decisions=review.json").status, 0);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("generate and apply a table rename with a second round of column decisions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-table-rename-"));
  try {
    const before =
      "CREATE TABLE people(id INTEGER PRIMARY KEY AUTOINCREMENT, surname TEXT, unused TEXT); CREATE INDEX by_name ON people(surname);";
    const after =
      'CREATE TABLE "Members"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT); CREATE INDEX by_name ON "Members"(name);';
    const path = join(cwd, "review.json");
    const read = (): MigrationDecisions => JSON.parse(readFileSync(path, "utf8"));
    const generate = (...args: string[]) => run(cwd, ["generate", "-", ...args], after);
    const dbPath = join(cwd, "db.sqlite");
    assert.equal(run(cwd, ["generate", "-"], before).status, 0);
    assert.equal(run(cwd, ["apply", dbPath]).status, 0);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "INSERT INTO people VALUES(1,'Ada',NULL),(10,'deleted',NULL); DELETE FROM people WHERE id=10",
      );
      assert.equal(generate("--write-decisions", path).status, 0);
      const first = read();
      assert.deepEqual(
        first.decisions.map((item) => item.candidates),
        [["members"]],
      );
      writeFileSync(
        path,
        JSON.stringify({
          ...first,
          decisions: first.decisions.map((item) => ({
            ...item,
            resolution: { action: "rename", target: "members" },
          })),
        }),
      );
      assert.match(generate("--decisions", path).stderr, /--merge-decisions/);
      assert.equal(generate("--merge-decisions", path).status, 0);
      const second = read();
      assert.deepEqual(
        second.decisions.map((item) => item.column),
        [undefined, "surname", "unused"],
      );
      writeFileSync(
        path,
        JSON.stringify({
          ...second,
          decisions: second.decisions.map((item) => ({
            ...item,
            resolution:
              item.column === "surname"
                ? { action: "rename", target: "name" }
                : item.column === "unused"
                  ? { action: "drop_if_empty" }
                  : item.resolution,
          })),
        }),
      );
      const answered = read();
      assert.equal(generate("--merge-decisions", path).status, 0);
      assert.deepEqual(read(), answered);
      const generated = generate("--decisions", path);
      assert.equal(generated.status, 0, generated.stderr);
      const applied = run(cwd, ["apply", dbPath]);
      assert.equal(applied.status, 0, applied.stderr);
      db.exec("INSERT INTO Members(name) VALUES('Grace')");
      assert.deepEqual(
        db
          .prepare("SELECT id,name FROM Members ORDER BY id")
          .all()
          .map((row) => [row.id, row.name]),
        [
          [1, "Ada"],
          [11, "Grace"],
        ],
      );
      assert.equal(
        db.prepare("SELECT tbl_name FROM sqlite_schema WHERE name='by_name'").get()?.tbl_name,
        "Members",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("interactive generation reviews table and column choices in memory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-interactive-"));
  try {
    const schema = join(cwd, "schema.sql");
    const args = ["generate", schema, "--interactive"];
    writeFileSync(join(cwd, ".uncutsqlrc.json"), '{"decisions":"missing.json"}');
    writeFileSync(schema, "CREATE TABLE people(id, old, unused)");
    const initial = run(cwd, args);
    assert.equal(initial.status, 0, initial.stderr);
    writeFileSync(schema, "CREATE TABLE members(id, name)");
    for (const input of ["3\nq\n", "3\n"]) {
      const cancelled = run(cwd, args, input);
      assert.equal(cancelled.status, 1, cancelled.stderr);
      assert.match(cancelled.stderr, /cancelled/);
      assert.equal(existsSync(join(cwd, "migrations/000002.sql")), false);
    }
    const reviewed = run(cwd, args, "invalid\n3\n3\n1\n");
    assert.equal(reviewed.status, 0, reviewed.stderr);
    const sql = readFileSync(join(cwd, "migrations/000002.sql"), "utf8");
    assert.match(sql, /"action":"rename","target":"members"/);
    assert.match(sql, /"action":"rename","target":"name"/);
    assert.match(sql, /"action":"drop_if_empty"/);
    assert.equal(existsSync(join(cwd, "missing.json")), false);
    assert.equal(existsSync(join(cwd, "uncutsql.decisions.json")), false);
    assert.match(run(cwd, args).stdout, /No schema changes/);
    assert.equal(run(cwd, [...args, "--write-decisions"]).status, 2);
    assert.equal(run(cwd, ["generate", "-", "--interactive"]).status, 2);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});
