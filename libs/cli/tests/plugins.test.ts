import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { resolveConfig, parseOptions } from "../src/config.ts";
import { loadDialect, loadDriver, PluginError } from "../src/plugins.ts";

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
      { cwd, input, encoding: "utf8" },
    );
  return { cwd, put, run, close: () => rmSync(cwd, { recursive: true, force: true }) };
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
        name: "fixture-dialect",
        type: "module",
        exports: { import: "./index.mjs" },
      }),
    );
    writeFileSync(join(dir, "index.mjs"), readFileSync(join(f.cwd, "dialect.mjs")));
    const result = f.run(["format", "--dialect", "fixture-dialect"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "fixture:input\n");
    const loaded = await Effect.runPromise(
      loadDialect({ specifier: "fixture-dialect", directory: f.cwd }),
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
        Effect.result(loadDialect({ specifier, directory: f.cwd })),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(result.failure instanceof PluginError);
    }
    f.put("driver.mjs", "export const executor = {dialect:'fixture', apply() {}};");
    assert.equal(
      (await Effect.runPromise(loadDriver({ specifier: "./driver.mjs", directory: f.cwd })))
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
      "export const executor = {dialect:'different', apply() { throw Error('must not execute'); }};",
    );
    mkdirSync(join(f.cwd, "migrations"));
    f.put(
      "migrations/uncutsql.lock.json",
      JSON.stringify({
        formatVersion: 1,
        dialect: "fixture",
        lastMigrationId: 1,
        lastMigrationSha256: "a".repeat(64),
        database: { tables: [] },
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
  for (const source of visit(new URL("../../sqlite/src/", import.meta.url)))
    assert.doesNotMatch(source, /node:sqlite|@uncutsql\/sqlite-driver/);
  for (const source of visit(new URL("../src/", import.meta.url)))
    assert.doesNotMatch(source, /node:sqlite|@uncutsql\/sqlite/);
});
