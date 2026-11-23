#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Data, Effect, Result } from "effect";
import { SchemaDiffError, MigrationDecisionError, prepareMigrationDecisions } from "@uncutsql/core";
import { ParseError } from "@uncutsql/codec";
import type { Dialect } from "@uncutsql/core";
import { parseOptions, resolveConfig, UsageError } from "./config.ts";
import { loadDialect, loadDriver } from "./plugins.ts";
import { applyGenerated } from "./apply.ts";
import { migrationFilename } from "./lock.ts";
import { generateMigration, prepareGeneratedDecisions } from "./generate.ts";
import { compareSchemas, renderMigration } from "./workflow.ts";

const help = `Usage: pnpm cli <check|format> [file|-]
       pnpm cli <diff|decisions|migration> <before-file|-> <after-file|->
       pnpm cli generate <schema-file|-> [output-dir]
       pnpm cli apply <database-target> [output-dir]

Options: --config <file>, --dialect <module>, --driver <module>
         --decisions <file>, --write-decisions <new-file> (migration/generate)
Flags override configuration. Drivers are loaded only for apply.

Read a SQL file, or stdin when file is omitted or '-'.
  check   Validate syntax supported by the selected dialect (no execution).
  format  Print canonical SQL to stdout; comments and formatting are discarded.
  diff    Print a structural schema diff as JSON (before -> after).
          At most one input may be stdin. Changes still exit successfully.
  decisions  Print unresolved migration choices as JSON (before -> after).
  migration  Print a transaction script for supported changes; never execute it.
  generate   Write the next migration and schema lock (default directory: migrations).
  apply      Apply pending files to a database and record applied history.

Statements require separating semicolons; the final semicolon is optional.
Input SQL files are never modified. Unsupported syntax is an error.
`;

class InputError extends Data.TaggedError("InputError")<{ readonly message: string }> {}

const readSchemaWith = (dialect: Dialect<unknown, unknown>, filename: string) =>
  Effect.gen(function* () {
    const label = filename === "-" ? "<stdin>" : filename;
    const source = yield* Effect.tryPromise({
      try: async () => {
        if (filename !== "-") return await readFile(filename, "utf8");
        process.stdin.setEncoding("utf8");
        let input = "";
        for await (const chunk of process.stdin) input += chunk;
        return input;
      },
      catch: (cause) =>
        new InputError({
          message: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    return yield* dialect.parse(source).pipe(
      Effect.mapError((error) => {
        if (!(error instanceof ParseError))
          return new InputError({ message: `${label}: ${error.message}` });
        const line = source.split(/\r\n|\r|\n/)[error.line - 1] ?? "";
        const prefix = line.slice(0, error.column - 1).replace(/[^\t]/g, " ");
        return new InputError({
          message: `${label}:${error.line}:${error.column}: ${error.message}\n${line}\n${prefix}^`,
        });
      }),
    );
  });

const validPath = (value: string) => !value.startsWith("-") || value === "-";
const program = Effect.gen(function* () {
  const { args, options } = yield* parseOptions(process.argv.slice(2));
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return help;
  const [command, filename = "-"] = args;
  if (
    !["check", "format", "diff", "decisions", "migration", "generate", "apply"].includes(
      command ?? "",
    )
  )
    return yield* Effect.fail(
      new UsageError({
        message: "Expected check, format, diff, decisions, migration, generate or apply.",
      }),
    );
  if (
    (options.decisions || options.writeDecisions) &&
    command !== "migration" &&
    command !== "generate"
  )
    return yield* Effect.fail(
      new UsageError({ message: "Decision-file options apply only to migration and generate." }),
    );
  if (options.decisions && options.writeDecisions)
    return yield* Effect.fail(
      new UsageError({ message: "Choose --decisions or --write-decisions, not both." }),
    );
  const decisions: unknown =
    options.decisions === undefined
      ? undefined
      : yield* Effect.tryPromise({
          try: async () => JSON.parse(await readFile(options.decisions!, "utf8")),
          catch: (cause) => new InputError({ message: `Cannot read decisions: ${String(cause)}` }),
        });
  const writeDecisions = (document: unknown) =>
    Effect.tryPromise({
      try: async () => {
        await writeFile(options.writeDecisions!, JSON.stringify(document, null, 2) + "\n", {
          flag: "wx",
        });
        return `Wrote ${options.writeDecisions}. Set each resolution to {"_tag":"Drop"} or {"_tag":"Rename","target":"column-key"}, then rerun with --decisions.\n`;
      },
      catch: (cause) =>
        new InputError({ message: `Cannot create decision file: ${String(cause)}` }),
    });
  const selected = yield* resolveConfig(options, process.cwd());
  // Apply only needs the driver's dialect ID; it does not load a SQL parser.
  const dialect = command === "apply" ? undefined : yield* loadDialect(selected.dialect);
  const readSchema = (path: string) => readSchemaWith(dialect!, path);
  if (command === "apply") {
    const directory = args[2] ?? "migrations";
    if (
      args.length < 2 ||
      args.length > 3 ||
      filename === "-" ||
      !validPath(filename) ||
      directory.startsWith("-")
    ) {
      return yield* Effect.fail(
        new UsageError({
          message: "apply requires a database target and an optional migration directory.",
        }),
      );
    }
    const executor = yield* loadDriver(selected.driver);
    const result = yield* applyGenerated(executor, filename, directory);
    return result.appliedIds.length
      ? `Applied ${result.appliedIds.map(migrationFilename).join(", ")}.\n`
      : "Database is up to date.\n";
  }
  if (command === "generate") {
    const directory = args[2] ?? "migrations";
    if (args.length < 2 || args.length > 3 || !validPath(filename) || directory.startsWith("-")) {
      return yield* Effect.fail(
        new UsageError({
          message: "generate requires a schema path (or -) and an optional output directory.",
        }),
      );
    }
    const ast = yield* readSchema(filename);
    if (options.writeDecisions)
      return yield* writeDecisions(yield* prepareGeneratedDecisions(dialect!, ast, directory));
    const result = yield* generateMigration(dialect!, ast, directory, decisions);
    return result.migrationPath
      ? `Generated ${result.migrationPath}\nUpdated ${result.lockPath}\n`
      : "No schema changes.\n";
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
    if (command === "decisions")
      return (
        JSON.stringify(
          yield* prepareMigrationDecisions(comparison.before, comparison.after),
          null,
          2,
        ) + "\n"
      );
    if (command === "migration") {
      if (options.writeDecisions)
        return yield* writeDecisions(
          yield* prepareMigrationDecisions(comparison.before, comparison.after),
        );
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
  const statements = yield* readSchema(filename);
  if (command === "check") return "Valid supported SQL syntax.\n";
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
  if (error instanceof MigrationDecisionError)
    process.stderr.write(
      "Use --write-decisions <new-file> to prepare choices; edit resolution fields, then rerun with --decisions <file>. No migration was generated.\n",
    );
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
