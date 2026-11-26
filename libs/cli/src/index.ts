#!/usr/bin/env node
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Result } from "effect";

import { MigrationDecisionError } from "@uncutsql/core";

import { parseOptions, UsageError } from "./config.ts";
import { initProject } from "./init.ts";
import { isRegisteredCommand, runCommands } from "./router.ts";

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

const program = Effect.gen(function* () {
  const { args, commandArgs, options } = yield* parseOptions(process.argv.slice(2));
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return help;
  }
  const [command] = args;
  if (command === undefined || isRegisteredCommand(command)) {
    return yield* runCommands(command === undefined ? commandArgs : [command, ...commandArgs]).pipe(
      Effect.provide(NodeServices.layer),
    );
  }
  if (command !== "init") {
    return yield* Effect.fail(
      new UsageError({
        message:
          "Expected init, check, format, diff, decisions, migration, generate, compact, extract, adopt, verify, apply, up or down.",
      }),
    );
  }
  if (options.decisions || options.decisionWriter) {
    return yield* Effect.fail(
      new UsageError({ message: "Decision-file options apply only to migration and generate." }),
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
  if (options.yes) {
    return yield* Effect.fail(new UsageError({ message: "--yes requires compact." }));
  }
  if (args.length !== 1 || options.schema === "-") {
    return yield* Effect.fail(
      new UsageError({
        message: "init accepts no positional arguments and requires a filesystem schema path.",
      }),
    );
  }
  return yield* initProject(options, process.cwd());
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
