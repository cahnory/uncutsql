#!/usr/bin/env node
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Result } from "effect";

import { MigrationDecisionError, prepareMigrationDecisions, SchemaDiffError } from "@uncutsql/core";

import { adoptGenerated, applyGenerated } from "./apply.ts";
import { compactGenerated } from "./compact.ts";
import { parseOptions, resolveConfig, UsageError } from "./config.ts";
import { decisionDocument, readDecisions, writeDecisions } from "./decision-file.ts";
import { writeExtractedSchema } from "./extract.ts";
import { compareGeneratedSchema } from "./generate.ts";
import { initProject } from "./init.ts";
import { baselineFilename, migrationFilename } from "./lock.ts";
import { loadDialect, loadDriver } from "./plugins.ts";
import { runCommands } from "./router.ts";
import { InputError, readSchemaWith } from "./schema-input.ts";
import { compareSchemas, renderMigration } from "./workflow.ts";

const help = `Usage: pnpm cli init
       pnpm cli <check|format> [file|-]
       pnpm cli diff [schema-path|-]
       pnpm cli <diff|decisions|migration> <before-file|-> <after-file|->
       pnpm cli generate [schema-path|-] [output-dir]
       pnpm cli compact <N> [output-dir] [--yes]
       pnpm cli extract <database-target> [schema-path|-]
       pnpm cli adopt <database-target> <N> [output-dir]
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
  extract    Export schema to a file, directory, or stdout (default: config.schema or stdout).
  adopt      Verify an existing database at migration N and initialize its migration history.
  verify     Verify the complete migration chain and lock without opening a database.
  apply, up  Apply pending files to a database and record applied history.
  down       Roll back the most recently applied migration.

Statements require separating semicolons; the final semicolon is optional.
Input SQL files are never modified. Unsupported syntax is an error.
`;

const validPath = (value: string) => !value.startsWith("-") || value === "-";
const program = Effect.gen(function* () {
  const { args, commandArgs, options } = yield* parseOptions(process.argv.slice(2));
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return help;
  }
  const [command = "diff", filename = "-"] = args;
  if (command === "verify" || command === "generate") {
    return yield* runCommands([command, ...commandArgs]).pipe(Effect.provide(NodeServices.layer));
  }
  if (
    ![
      "init",
      "check",
      "format",
      "diff",
      "decisions",
      "migration",
      "extract",
      "adopt",
      "compact",
      "apply",
      "up",
      "down",
    ].includes(command ?? "")
  ) {
    return yield* Effect.fail(
      new UsageError({
        message:
          "Expected init, check, format, diff, decisions, migration, generate, compact, extract, adopt, verify, apply, up or down.",
      }),
    );
  }
  if ((options.decisions || options.decisionWriter) && command !== "migration") {
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
  if (options.interactive) {
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
  const decisions =
    command === "migration" && !options.decisionWriter ? yield* readDecisions(selected) : undefined;
  if (command === "extract") {
    const destination = args[2] ?? selected.schema ?? "-";
    if (!args[1] || filename.startsWith("-") || args.length > 3 || !validPath(destination)) {
      return yield* Effect.fail(
        new UsageError({
          message: "extract requires a database target and an optional schema path.",
        }),
      );
    }
    const executor = yield* loadDriver(selected.driver);
    if (!executor.extract) {
      return yield* Effect.fail(
        new InputError({ message: "Driver does not support schema extraction." }),
      );
    }
    const parts = yield* executor.extract(filename);
    if (destination === "-") {
      return parts.map((part) => part.sql).join("\n");
    }
    yield* Effect.tryPromise({
      catch: (cause) => new InputError({ message: String(cause) }),
      try: () => writeExtractedSchema(filename, destination, parts),
    });
    return parts.length
      ? `Extracted schema to ${destination}.\nFor an untracked database, generate the first migration from this schema, then run adopt at migration 1. If migrations already exist, use adopt with the matching migration number.\n`
      : `Extracted empty schema to ${destination}.\n`;
  }
  if (command === "adopt") {
    const directory = args[3] ?? selected.migrations ?? "migrations";
    if (
      !args[1] ||
      filename.startsWith("-") ||
      !/^\d+$/.test(args[2] ?? "") ||
      args.length > 4 ||
      directory.startsWith("-")
    ) {
      return yield* Effect.fail(
        new UsageError({
          message:
            "adopt requires a database target, a migration number and an optional migration directory.",
        }),
      );
    }
    const executor = yield* loadDriver(selected.driver);
    const id = Number(args[2]);
    yield* adoptGenerated(executor, filename, directory, id);
    return `Initialized database history through migration ${id}.\n`;
  }
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
  // Apply only needs the driver's dialect ID; it does not load a SQL parser.
  const executing = command === "apply" || command === "up" || command === "down";
  const dialect = executing ? undefined : yield* loadDialect(selected.dialect);
  const readSchema = (path: string) => readSchemaWith(dialect!, path, process.stdin);
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
          options.decisionWriter.path ?? selected.decisions,
          options.decisionWriter.flag,
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

// Run the selected command once and map failures to process exit codes.
const result = await Effect.runPromise(Effect.result(program));
if (Result.isSuccess(result)) {
  if (result.success) {
    process.stdout.write(result.success);
  }
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
