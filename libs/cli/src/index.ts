#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Data, Effect, Result } from "effect";

import { ParseError } from "@uncutsql/codec";
import { MigrationDecisionError, prepareMigrationDecisions, SchemaDiffError } from "@uncutsql/core";
import type { Dialect, MigrationDecisions } from "@uncutsql/core";

import { applyGenerated, verifyGenerated } from "./apply.ts";
import { compactGenerated } from "./compact.ts";
import { parseOptions, resolveConfig, UsageError } from "./config.ts";
import { decisionDocument, writeDecisionFile } from "./decision-file.ts";
import {
  compareGeneratedSchema,
  generateMigration,
  prepareGeneratedDecisions,
} from "./generate.ts";
import { initProject } from "./init.ts";
import { promptDecisions } from "./interactive.ts";
import { baselineFilename, migrationFilename } from "./lock.ts";
import { loadDialect, loadDriver } from "./plugins.ts";
import { schemaFiles } from "./schema-files.ts";
import { style } from "./terminal.ts";
import { compareSchemas, renderMigration } from "./workflow.ts";

const help = `Usage: pnpm cli init
       pnpm cli <check|format> [file|-]
       pnpm cli diff [schema-path|-]
       pnpm cli <diff|decisions|migration> <before-file|-> <after-file|->
       pnpm cli generate [schema-path|-] [output-dir]
       pnpm cli compact <N> [output-dir] [--yes]
       pnpm cli verify [output-dir]
       pnpm cli apply|up|down <database-target> [output-dir]

Options: --config <file>, --dialect <module>, --driver <module>
         --schema <path|->, --migrations <directory>
         --interactive              Answer generate decisions on stdin (schema file or directory)
         --decisions <file> (migration/generate)
         --write-decisions [file]    Create a new decision file
         --rewrite-decisions [file]  Reset all current decisions to pending
         --merge-decisions [file]    Refresh while keeping applicable choices
Positional paths override flags; flags override configuration. Execution commands load the driver.

Schema paths accept files or directories of **/*.uncut.sql in sorted path order.
check, format and generate use config.schema when the path is omitted.
Use '-' for stdin. Without config.schema, check and format default to stdin.
generate, apply, up and down use config.migrations unless an output directory is supplied.
Decisions default to config.decisions or uncutsql.decisions.json beside the config
(working directory without config). Choose one decision-file option for migration or generate.
  init    Interactively set up a schema and migrations directory.
  check   Validate syntax supported by the selected dialect (no execution).
  format  Print canonical SQL to stdout; comments and formatting are discarded.
  diff    Compare the configured schema (or one path) to the migration lock.
          Two paths compare SQL schemas directly. No command defaults to diff.
          A missing baseline is an empty schema. Output is JSON.
          At most one input may be stdin. Changes still exit successfully.
  decisions  Print unresolved migration choices as JSON (before -> after).
  migration  Print a transaction script for supported changes; never execute it.
  generate   Write the next migration and schema lock (default directory: migrations).
  compact    Replace migrations 1 through N with a baseline. --yes confirms deletion.
  verify     Verify the complete migration chain and lock without opening a database.
  apply, up  Apply pending files to a database and record applied history.
  down       Roll back the most recently applied migration.

Statements require separating semicolons; the final semicolon is optional.
Input SQL files are never modified. Unsupported syntax is an error.
`;

class InputError extends Data.TaggedError("InputError")<{ readonly message: string }> {}

const readFileWith = (dialect: Dialect<unknown, unknown>, filename: string) =>
  Effect.gen(function* () {
    const label = filename === "-" ? "<stdin>" : filename;
    const source = yield* Effect.tryPromise({
      catch: (cause) =>
        new InputError({
          message: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      try: async () => {
        if (filename !== "-") {
          return await readFile(filename, "utf8");
        }
        process.stdin.setEncoding("utf8");
        let input = "";
        for await (const chunk of process.stdin) {
          input += chunk;
        }
        return input;
      },
    });
    return yield* dialect.parse(source).pipe(
      Effect.mapError((error) => {
        if (!(error instanceof ParseError)) {
          return new InputError({ message: `${label}: ${error.message}` });
        }
        const line = source.split(/\r\n|\r|\n/)[error.line - 1] ?? "";
        const prefix = line.slice(0, error.column - 1).replace(/[^\t]/g, " ");
        return new InputError({
          message: `${style("bold", `${label}:${error.line}:${error.column}`)}: ${error.message}\n${line}\n${prefix}${style("red", "^")}`,
        });
      }),
    );
  });

const readSchemaWith = (dialect: Dialect<unknown, unknown>, path: string) =>
  Effect.gen(function* () {
    if (path === "-") {
      return yield* readFileWith(dialect, path);
    }
    const files = yield* Effect.tryPromise({
      catch: (cause) => new InputError({ message: `${path}: ${String(cause)}` }),
      try: () => schemaFiles(path),
    });
    if (!files.length) {
      return yield* Effect.fail(
        new InputError({ message: `${path}: no *.uncut.sql schema files found` }),
      );
    }
    if (files.length === 1) {
      return yield* readFileWith(dialect, files[0]!);
    }
    if (!dialect.combineSchemas) {
      return yield* Effect.fail(
        new InputError({ message: `Dialect ${dialect.name} does not support multipart schemas` }),
      );
    }
    const parts = yield* Effect.forEach(files, (file) => readFileWith(dialect, file));
    return dialect.combineSchemas(parts);
  });

const validPath = (value: string) => !value.startsWith("-") || value === "-";
const program = Effect.gen(function* () {
  const { args, options } = yield* parseOptions(process.argv.slice(2));
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return help;
  }
  const [command = "diff", filename = "-"] = args;
  if (
    ![
      "init",
      "check",
      "format",
      "diff",
      "decisions",
      "migration",
      "generate",
      "compact",
      "verify",
      "apply",
      "up",
      "down",
    ].includes(command ?? "")
  ) {
    return yield* Effect.fail(
      new UsageError({
        message:
          "Expected init, check, format, diff, decisions, migration, generate, compact, verify, apply, up or down.",
      }),
    );
  }
  if (
    (options.decisions || options.decisionWriter) &&
    command !== "migration" &&
    command !== "generate"
  ) {
    return yield* Effect.fail(
      new UsageError({ message: "Decision-file options apply only to migration and generate." }),
    );
  }
  if (options.decisions && options.decisionWriter) {
    return yield* Effect.fail(
      new UsageError({
        message: `Choose only one of --decisions and ${options.decisionWriter.flag}.`,
      }),
    );
  }
  if (
    options.interactive &&
    (command !== "generate" || options.decisions || options.decisionWriter)
  ) {
    return yield* Effect.fail(
      new UsageError({
        message:
          "--interactive requires generate and cannot be combined with decision-file options.",
      }),
    );
  }
  if (options.yes && command !== "compact") {
    return yield* Effect.fail(new UsageError({ message: "--yes requires compact." }));
  }
  if (command === "init") {
    if (args.length !== 1 || options.schema === "-") {
      return yield* Effect.fail(
        new UsageError({
          message: "init accepts no positional arguments and requires a filesystem schema path.",
        }),
      );
    }
    return yield* initProject(options, process.cwd());
  }
  const selected = yield* resolveConfig(options, process.cwd());
  const decisions: unknown =
    (command !== "generate" && command !== "migration") ||
    options.decisionWriter ||
    options.interactive
      ? undefined
      : yield* Effect.tryPromise({
          catch: (cause) =>
            new InputError({
              message: `Cannot read decisions ${selected.decisions}: ${String(cause)}`,
            }),
          try: async () => {
            let source: string;
            try {
              source = await readFile(selected.decisions, "utf8");
            } catch (cause) {
              if (
                !selected.decisionsRequired &&
                cause !== null &&
                typeof cause === "object" &&
                "code" in cause &&
                cause.code === "ENOENT"
              ) {
                return undefined;
              }
              throw cause;
            }
            return JSON.parse(source);
          },
        });
  const writeDecisions = (document: MigrationDecisions) => {
    const writer = options.decisionWriter!;
    const path = writer.path ?? selected.decisions;
    return Effect.tryPromise({
      catch: (cause) =>
        new InputError({
          message: `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      try: () => writeDecisionFile(document, path, writer.flag),
    });
  };
  if (command === "compact") {
    const directory = args[2] ?? selected.migrations ?? "migrations";
    if (!/^\d+$/.test(filename) || args.length > 3 || directory.startsWith("-")) {
      return yield* Effect.fail(
        new UsageError({
          message: "compact requires a migration number and an optional migration directory.",
        }),
      );
    }
    const executor = yield* loadDriver(selected.driver);
    const done = yield* compactGenerated(
      executor,
      directory,
      Number(filename),
      options.yes ?? false,
    );
    return done
      ? `Compacted migrations 1 through ${Number(filename)}.\n`
      : "Compaction cancelled.\n";
  }
  if (command === "verify") {
    const directory = args[1] ?? selected.migrations ?? "migrations";
    if (args.length > 2 || directory.startsWith("-")) {
      return yield* Effect.fail(
        new UsageError({ message: "verify accepts an optional migration directory." }),
      );
    }
    const count = yield* verifyGenerated(directory);
    return `Verified ${count} migration(s).\n`;
  }
  // Apply only needs the driver's dialect ID; it does not load a SQL parser.
  const executing = command === "apply" || command === "up" || command === "down";
  const dialect = executing ? undefined : yield* loadDialect(selected.dialect);
  const readSchema = (path: string) => readSchemaWith(dialect!, path);
  if (executing) {
    const directory = args[2] ?? selected.migrations ?? "migrations";
    if (
      args.length < 2 ||
      args.length > 3 ||
      filename === "-" ||
      !validPath(filename) ||
      directory.startsWith("-")
    ) {
      return yield* Effect.fail(
        new UsageError({
          message: `${command} requires a database target and an optional migration directory.`,
        }),
      );
    }
    const executor = yield* loadDriver(selected.driver);
    const result = yield* applyGenerated(
      executor,
      filename,
      directory,
      command === "down" ? "down" : "up",
    );
    if (command === "down") {
      return result.rolledBackId === undefined
        ? "No applied migrations.\n"
        : `Rolled back ${migrationFilename(result.rolledBackId)}.\n`;
    }
    return result.appliedIds.length
      ? `Applied ${result.appliedIds.map((id) => (id === result.baselineId ? baselineFilename(id) : migrationFilename(id))).join(", ")}.\n`
      : "Database is up to date.\n";
  }
  if (command === "generate") {
    const directory = args[2] ?? selected.migrations ?? "migrations";
    if (
      (!args[1] && !selected.schema) ||
      args.length > 3 ||
      !validPath(filename) ||
      directory.startsWith("-")
    ) {
      return yield* Effect.fail(
        new UsageError({
          message: "generate requires a schema path (or -) and an optional output directory.",
        }),
      );
    }
    const path = args[1] ?? selected.schema!;
    if (options.interactive && path === "-") {
      return yield* Effect.fail(
        new UsageError({
          message:
            "--interactive reads answers from stdin. Supply the schema as a file or directory.",
        }),
      );
    }
    const ast = yield* readSchema(path);
    if (options.decisionWriter) {
      return yield* writeDecisions(yield* prepareGeneratedDecisions(dialect!, ast, directory));
    }
    const reviewed = options.interactive
      ? yield* promptDecisions(
          yield* prepareGeneratedDecisions(dialect!, ast, directory),
          dialect!.supportsDropGuards === true,
        )
      : decisions;
    const result = yield* generateMigration(dialect!, ast, directory, reviewed);
    return result.migrationPath
      ? `${style("green", "Generated", process.stdout)} ${result.migrationPath}\n${style("cyan", "Updated", process.stdout)} ${result.lockPath}\n`
      : "No schema changes.\n";
  }
  if (command === "diff" && args.length <= 2) {
    const path = args[1] ?? selected.schema;
    if (!path || !validPath(path)) {
      return yield* Effect.fail(
        new UsageError({
          message: "diff requires a schema path or config.schema (or --schema).",
        }),
      );
    }
    const comparison = yield* compareGeneratedSchema(
      dialect!,
      yield* readSchema(path),
      selected.migrations ?? "migrations",
    );
    return `${JSON.stringify(comparison.diff, null, 2)}\n`;
  }
  if (command === "diff" || command === "migration" || command === "decisions") {
    const target = args[2];
    if (
      args.length !== 3 ||
      target === undefined ||
      !validPath(filename) ||
      !validPath(target) ||
      (filename === "-" && target === "-")
    ) {
      return yield* Effect.fail(
        new UsageError({ message: `${command} requires two paths; at most one may be stdin (-).` }),
      );
    }
    const before = yield* readSchema(filename);
    const after = yield* readSchema(target);
    const comparison = yield* compareSchemas(dialect!, before, after).pipe(
      Effect.mapError(
        (error) =>
          new InputError({
            message:
              error instanceof SchemaDiffError
                ? error.diagnostics
                    .map((item) => `${item.side === "before" ? filename : target}: ${item.message}`)
                    .join("\n")
                : error.message,
          }),
      ),
    );
    if (command === "decisions") {
      return (
        JSON.stringify(
          yield* prepareMigrationDecisions(comparison.before, comparison.after).pipe(
            Effect.flatMap((document) => Effect.promise(() => decisionDocument(document))),
          ),
          null,
          2,
        ) + "\n"
      );
    }
    if (command === "migration") {
      if (options.decisionWriter) {
        return yield* writeDecisions(
          yield* prepareMigrationDecisions(comparison.before, comparison.after),
        );
      }
      const sql = yield* renderMigration(dialect!, comparison, decisions);
      return sql.length ? `${sql}\n` : "";
    }
    const diff = comparison.diff;
    return `${JSON.stringify(diff, null, 2)}\n`;
  }
  if ((command !== "check" && command !== "format") || args.length > 2 || !validPath(filename)) {
    return yield* Effect.fail(
      new UsageError({
        message: "Expected check, format, diff, migration, generate or apply with input paths.",
      }),
    );
  }
  const statements = yield* readSchema(args[1] ?? selected.schema ?? "-");
  if (command === "check") {
    return "Valid supported SQL syntax.\n";
  }
  const sql = yield* dialect!.format(statements);
  return sql.length === 0 ? "" : `${sql}\n`;
});

// Only the executable boundary runs Effects and writes to process streams.
const result = await Effect.runPromise(Effect.result(program));
if (Result.isSuccess(result)) {
  process.stdout.write(result.success);
} else {
  const error = result.failure;
  process.stderr.write(`${error.message}\n${error instanceof UsageError ? `\n${help}` : ""}`);
  if (error instanceof MigrationDecisionError) {
    process.stderr.write(
      "Use --write-decisions [new-file] to start a review or --merge-decisions [file] to refresh an existing review. No migration was generated.\n",
    );
  }
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
