import { readFile } from "node:fs/promises";
import { Data, Effect, Result } from "effect";
import { SchemaDiffError } from "@uncutsql/core";
import { ParseError } from "@uncutsql/codec";
import { dialect } from "./dialect.ts";
import { generateMigration } from "./generate.ts";
import { compareSchemas, renderMigration } from "./workflow.ts";

const help = `Usage: pnpm cli <check|format> [file|-]
       pnpm cli <diff|migration> <before-file|-> <after-file|->
       pnpm cli generate <schema-file|-> [output-dir]

Read a SQL file, or stdin when file is omitted or '-'.
  check   Validate syntax supported by the selected dialect (no execution).
  format  Print canonical SQL to stdout; comments and formatting are discarded.
  diff    Print a structural schema diff as JSON (before -> after).
          At most one input may be stdin. Changes still exit successfully.
  migration  Print a transaction script for supported changes; never execute it.
  generate   Write the next migration and schema lock (default directory: migrations).

Statements require separating semicolons; the final semicolon is optional.
Input SQL files are never modified. Unsupported syntax is an error.
`;

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}
class InputError extends Data.TaggedError("InputError")<{ readonly message: string }> {}

const readSchema = (filename: string) =>
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

const args = process.argv.slice(2);
const validPath = (value: string) => !value.startsWith("-") || value === "-";
const program = Effect.gen(function* () {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return help;
  const [command, filename = "-"] = args;
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
    const result = yield* generateMigration(dialect, ast, directory);
    return result.migrationPath
      ? `Generated ${result.migrationPath}\nUpdated ${result.lockPath}\n`
      : "No schema changes.\n";
  }
  if (command === "diff" || command === "migration") {
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
    const comparison = yield* compareSchemas(dialect, before, after).pipe(
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
    if (command === "migration") {
      const sql = yield* renderMigration(dialect, comparison);
      return sql.length ? `${sql}\n` : "";
    }
    const diff = comparison.diff;
    return `${JSON.stringify(diff, null, 2)}\n`;
  }
  if ((command !== "check" && command !== "format") || args.length > 2 || !validPath(filename)) {
    return yield* Effect.fail(
      new UsageError({
        message: "Expected check, format, diff, migration or generate with input paths.",
      }),
    );
  }
  const statements = yield* readSchema(filename);
  if (command === "check") return "Valid supported SQL syntax.\n";
  const sql = yield* dialect.format(statements);
  return sql.length === 0 ? "" : `${sql}\n`;
});

// Only the executable boundary runs Effects and writes to process streams.
const result = await Effect.runPromise(Effect.result(program));
if (Result.isSuccess(result)) {
  process.stdout.write(result.success);
} else {
  const error = result.failure;
  process.stderr.write(`${error.message}\n${error instanceof UsageError ? `\n${help}` : ""}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
