import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Result } from "effect";

import { parseOptions, resolveConfig, UsageError } from "../src/config.ts";
import { loadDialect, loadDriver, PluginError } from "../src/plugins.ts";
import { runCommands } from "../src/router.ts";

const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-plugins-"));
  const put = (name: string, content: string) => writeFileSync(join(cwd, name), content);
  const effect = JSON.stringify(import.meta.resolve("effect"));
  put(
    "dialect.mjs",
    `import { Effect } from ${effect};
    export default { name: 'fixture', parse: value => Effect.succeed(value),
      format: value => Effect.succeed('fixture:' + value),
      toDatabaseSchema: () => Effect.succeed({tables:[]}),
      lowerMigration: value => Effect.succeed(value), encodeMigration: () => Effect.succeed('') };`,
  );
  put("bad.mjs", "throw new Error('should not be loaded');");
  const run = (args: string[], input = "input") =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../src/index.ts", import.meta.url)), ...args],
      { cwd, encoding: "utf8", input },
    );
  return { close: () => rmSync(cwd, { force: true, recursive: true }), cwd, put, run };
};

test("CLI loads configured dialects without loading the configured driver", () => {
  const f = fixture();
  try {
    f.put(
      "uncutsql.config.json",
      JSON.stringify({ dialect: "./dialect.mjs", driver: "./bad.mjs" }),
    );
    const result = f.run(["format"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "fixture:input\n");
    assert.equal(result.stderr, "");
    const apply = f.run(["apply", "target"]);
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /Cannot load driver.*should not be loaded/);
  } finally {
    f.close();
  }
});

test("CLI flags override config and explicit config resolves relative module paths from its directory", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.cwd, "config"));
    f.put("config/settings.json", JSON.stringify({ dialect: "../dialect.mjs" }));
    let result = f.run(["format", "--config", "config/settings.json"]);
    assert.equal(result.status, 0, result.stderr);
    f.put("config/settings.json", JSON.stringify({ dialect: "../bad.mjs" }));
    result = f.run(["--config=config/settings.json", "format", "--dialect=./dialect.mjs"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "fixture:input\n");
  } finally {
    f.close();
  }
});

test("package config precedes discovered config; JS config supports default export", () => {
  const f = fixture();
  try {
    f.put("uncutsql.config.mjs", "export default { dialect: './dialect.mjs' };");
    assert.equal(f.run(["format"]).status, 0);
    f.put("package.json", JSON.stringify({ uncutsql: { dialect: "./bad.mjs" } }));
    assert.match(f.run(["format"]).stderr, /should not be loaded/);
    assert.equal(f.run(["format", "--config", "uncutsql.config.mjs"]).status, 0);
  } finally {
    f.close();
  }
});

test("bare plugin packages resolve from the consumer with import export conditions", async () => {
  const f = fixture();
  try {
    const dir = join(f.cwd, "node_modules", "fixture-dialect");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        exports: { import: "./index.mjs" },
        name: "fixture-dialect",
        type: "module",
      }),
    );
    writeFileSync(join(dir, "index.mjs"), readFileSync(join(f.cwd, "dialect.mjs")));
    const result = f.run(["format", "--dialect", "fixture-dialect"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "fixture:input\n");
    const loaded = await Effect.runPromise(
      loadDialect({ directory: f.cwd, specifier: "fixture-dialect" }),
    );
    assert.equal(loaded.name, "fixture");
  } finally {
    f.close();
  }
});

test("configuration and invalid adapter failures are actionable typed errors", async () => {
  const f = fixture();
  try {
    f.put("invalid.mjs", "export default { name: 'incomplete', parse() {} };");
    for (const specifier of ["./missing.mjs", "./invalid.mjs"]) {
      const result = await Effect.runPromise(
        Effect.result(loadDialect({ directory: f.cwd, specifier })),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(result.failure instanceof PluginError);
    }
    f.put(
      "driver.mjs",
      "export const executor = {dialect:'fixture', checkpoint() {}, apply() {}};",
    );
    assert.equal(
      (await Effect.runPromise(loadDriver({ directory: f.cwd, specifier: "./driver.mjs" })))
        .dialect,
      "fixture",
    );
    assert.match(f.run(["format"]).stderr, /Select a dialect/);
    assert.match(
      f.run(["format", "--config", "missing.json"]).stderr,
      /Configuration file not found/,
    );
    f.put("uncutsql.config.json", '{"dialect": 42}');
    assert.match(f.run(["format"]).stderr, /dialect must be a nonempty/);
    assert.equal(f.run(["--help"]).status, 0);
    const result = await Effect.runPromise(Effect.result(resolveConfig({}, f.cwd)));
    assert.ok(Result.isFailure(result));
    for (const args of [
      ["--dialect"],
      ["--driver="],
      ["--merge-decisions="],
      ["--merge-decisions", "--write-decisions"],
      ["generate", "--write-decisions", "--rewrite-decisions"],
      ["--rewrite-decisions", "--merge-decisions"],
      ["--config", "--dialect"],
      ["--dialect", "x", "--dialect", "y"],
    ]) {
      assert.ok(Result.isFailure(Effect.runSync(Effect.result(parseOptions(args)))));
    }
  } finally {
    f.close();
  }
});

test("apply does not load the dialect and verifies the driver's identity against the lock", () => {
  const f = fixture();
  try {
    f.put("uncutsql.config.json", JSON.stringify({ dialect: "./bad.mjs", driver: "./driver.mjs" }));
    f.put(
      "driver.mjs",
      "export const executor = {dialect:'different', checkpoint() {}, apply() { throw Error('must not execute'); }};",
    );
    mkdirSync(join(f.cwd, "migrations"));
    f.put(
      "migrations/uncutsql.lock.json",
      JSON.stringify({
        database: { tables: [] },
        dialect: "fixture",
        formatVersion: 2,
        lastMigrationId: 1,
        lastMigrationSha256: "a".repeat(64),
      }),
    );
    const result = f.run(["apply", "target"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Lock dialect.*does not match/);
    assert.doesNotMatch(result.stderr, /should not be loaded|must not execute/);
  } finally {
    f.close();
  }
});

test("package boundaries keep the CLI independent and the dialect driver-free", () => {
  const cli = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(cli.dependencies["@uncutsql/sqlite"], undefined);
  assert.equal(cli.dependencies["@uncutsql/sqlite-driver"], undefined);
  const visit = (path: URL): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), path);
      return entry.isDirectory()
        ? visit(child)
        : entry.name.endsWith(".ts")
          ? [readFileSync(child, "utf8")]
          : [];
    });
  for (const source of visit(new URL("../../sqlite/src/", import.meta.url))) {
    assert.doesNotMatch(source, /node:sqlite|@uncutsql\/sqlite-driver/);
  }
  for (const source of visit(new URL("../src/", import.meta.url))) {
    assert.doesNotMatch(source, /node:sqlite|@uncutsql\/sqlite/);
  }
});

test("init confirms before writing and reuses existing project files on rerun", () => {
  const f = fixture();
  try {
    const args = ["init", "--dialect", "./dialect.mjs", "--driver", "./bad.mjs"];
    assert.match(f.run(args, "\ndb/schema/\ndb/migrations\n").stderr, /cancelled/);
    assert.deepEqual(readdirSync(f.cwd).sort(), ["bad.mjs", "dialect.mjs"]);
    const first = f.run(args, "\ndb/schema/\ndb/migrations\ny\n");
    assert.equal(first.status, 0, first.stderr);
    const config = readFileSync(join(f.cwd, "uncutsql.config.json"), "utf8");
    f.put("db/schema/schema.uncut.sql", "original schema");
    f.put("db/migrations/000001.sql", "migration history");
    const again = f.run(["init"], "\ny\n");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(f.cwd, "uncutsql.config.json"), "utf8"), config);
    assert.equal(f.run(["format"]).stdout, "fixture:original schema\n");
    assert.equal(
      readFileSync(join(f.cwd, "db/migrations/000001.sql"), "utf8"),
      "migration history",
    );
  } finally {
    f.close();
  }
});

test("init uses the directory of an existing module config and detects path conflicts", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.cwd, "project"));
    f.put("project/settings.mjs", "export default { migrations: './history' };");
    f.put("project/history", "existing file");
    const args = [
      "init",
      "--config",
      "project/settings.mjs",
      "--dialect",
      "./dialect.mjs",
      "--driver",
      "./bad.mjs",
    ];
    const conflict = f.run(args, "\ny\n");
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /Expected a migrations directory/);
    assert.deepEqual(readdirSync(join(f.cwd, "project")).sort(), ["history", "settings.mjs"]);
    rmSync(join(f.cwd, "project/history"));
    const result = f.run(args, "\ny\n");
    assert.equal(result.status, 0, result.stderr);
    const check = f.run(["check", "--config", "project/settings.mjs"]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(readFileSync(join(f.cwd, "project/settings.mjs"), "utf8"), /schema\.uncut\.sql/);
    assert.deepEqual(readdirSync(join(f.cwd, "project")).sort(), [
      "history",
      "schema.uncut.sql",
      "settings.mjs",
    ]);
  } finally {
    f.close();
  }
});

test("init asks only for missing migrations and honors an explicit flag", () => {
  const f = fixture();
  try {
    for (const migrations of [undefined, "history"]) {
      f.put(
        "uncutsql.config.json",
        JSON.stringify({
          dialect: "./dialect.mjs",
          driver: "./bad.mjs",
          migrations,
          schema: "schema.sql",
        }),
      );
      const target = migrations ?? "db/migrations";
      const result = f.run(["init"], migrations ? "\ny\n" : `\n${target}\ny\n`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr.includes("Migrations directory [migrations]"), !migrations);
      assert.equal(
        JSON.parse(readFileSync(join(f.cwd, "uncutsql.config.json"), "utf8")).migrations,
        target,
      );
      assert.deepEqual(readdirSync(join(f.cwd, target)), []);
    }
    const flagged = f.run(["init", "--migrations", "from-flag"], "\ny\n");
    assert.equal(flagged.status, 0, flagged.stderr);
    assert.deepEqual(readdirSync(join(f.cwd, "from-flag")), []);
  } finally {
    f.close();
  }
});

test("init offers official plugins by number and accepts custom modules independently", () => {
  for (const [dialectAnswer, driverAnswer, dialect, driver] of [
    ["1", "1", "@uncutsql/sqlite", "@uncutsql/sqlite-driver"],
    ["1", "./custom-driver.mjs", "@uncutsql/sqlite", "./custom-driver.mjs"],
    ["./dialect.mjs", "1", "./dialect.mjs", "@uncutsql/sqlite-driver"],
    ["", "", undefined, undefined],
  ] as const) {
    const f = fixture();
    try {
      const result = f.run(["init"], ["", dialectAnswer, driverAnswer, "", "", "y", ""].join("\n"));
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /1\) @uncutsql\/sqlite\n/);
      assert.match(result.stderr, /1\) @uncutsql\/sqlite-driver\n/);
      const config = JSON.parse(readFileSync(join(f.cwd, "uncutsql.config.json"), "utf8"));
      assert.equal(config.dialect, dialect);
      assert.equal(config.driver, driver);
    } finally {
      f.close();
    }
  }
});

test("init creates an independent named config from the prompt or flag", () => {
  const f = fixture();
  try {
    f.put("uncutsql.config.json", "invalid default");
    for (const flag of [false, true]) {
      const name = flag ? "alternate/flag.json" : "alternate/prompt.json";
      const args = ["init", "--dialect", "./dialect.mjs", "--driver", "./bad.mjs"];
      if (flag) {
        args.push("--config", name);
      }
      const result = f.run(args, (flag ? "" : name + "\n") + "tables.sql\nhistory\ny\n");
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(name));
      const config = JSON.parse(readFileSync(join(f.cwd, name), "utf8"));
      assert.equal(config.schema, "tables.sql");
      assert.equal(config.migrations, "history");
      const check = f.run(["check", "--config", name]);
      assert.equal(check.status, 0, check.stderr);
    }
    assert.equal(readFileSync(join(f.cwd, "uncutsql.config.json"), "utf8"), "invalid default");
  } finally {
    f.close();
  }
});

test("init saves missing fields in the discovered package config only after confirmation", () => {
  const f = fixture();
  try {
    const manifest = {
      name: "project",
      uncutsql: { decisions: "review.json", dialect: "./dialect.mjs" },
    };
    const original = JSON.stringify(manifest);
    f.put("package.json", original);
    const answers = "\n./bad.mjs\ndb/schema.sql\ndb/history\n";
    const cancelled = f.run(["init"], answers + "n\n");
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(readFileSync(join(f.cwd, "package.json"), "utf8"), original);
    const result = f.run(["init"], answers + "y\n");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, "package.json"), "utf8")), {
      name: "project",
      uncutsql: {
        ...manifest.uncutsql,
        driver: "./bad.mjs",
        migrations: "db/history",
        schema: "db/schema.sql",
      },
    });
    const check = f.run(["check"]);
    assert.equal(check.status, 0, check.stderr);
  } finally {
    f.close();
  }
});

test("init lists available configs and displays all six steps for the selected file", () => {
  const f = fixture();
  try {
    f.put("uncutsql.config.mjs", "throw Error('unselected config loaded')");
    f.put(
      "reporting.json",
      JSON.stringify({ dialect: "./dialect.mjs", driver: "./bad.mjs", schema: "report.sql" }),
    );
    const result = f.run(["init"], "2\nreports/history\ny\n");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /1\) uncutsql.config.mjs\n  2\) reporting.json/);
    assert.deepEqual(
      [...result.stderr.matchAll(/(\d+)\/6  ([^\n]+)/g)].map((match) => match[2]),
      ["Config file", "Dialect", "Driver", "Schema", "Migrations", "Confirm setup"],
    );
    assert.match(result.stderr, /Dialect\nUsing .+already set in config/);
    assert.equal(
      JSON.parse(readFileSync(join(f.cwd, "reporting.json"), "utf8")).migrations,
      "reports/history",
    );
  } finally {
    f.close();
  }
});

test("registered commands show help before config discovery", () => {
  const f = fixture();
  try {
    f.put("uncutsql.config.mjs", "throw Error('config loaded')");
    for (const command of [
      "check",
      "format",
      "verify",
      "generate",
      "diff",
      "decisions",
      "migration",
    ]) {
      const result = f.run([command, "--help"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.ok(result.stdout.includes(`uncutsql ${command} [flags]`));
      assert.match(result.stdout, /--migrations/);
      assert.equal(
        result.stdout.includes("--write-decisions"),
        command === "generate" || command === "migration",
      );
    }
    const invalid = f.run(["verify", "a", "b"]);
    assert.equal(invalid.status, 2, invalid.stderr);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Unexpected positional argument/);
  } finally {
    f.close();
  }
});

test("review commands reject competing modes before opening config", async () => {
  for (const args of [
    ["migration", "before.sql", "after.sql", "--decisions=a.json", "--merge-decisions"],
    ["generate", "--decisions=a.json", "--merge-decisions"],
    ["generate", "--write-decisions", "--rewrite-decisions"],
    ["generate", "--interactive", "--decisions=a.json"],
  ]) {
    const result = await Effect.runPromise(
      runCommands([...args, "--config=missing.json"]).pipe(
        Effect.provide(NodeServices.layer),
        Effect.result,
      ),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof UsageError);
    assert.match(result.failure.message, /decision-file/);
  }
});
