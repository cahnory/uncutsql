import { readFile } from "node:fs/promises";
import { Data, Effect, Result } from "effect";
import { schema } from "@uncutsql/sqlite";

const help = `Usage: pnpm cli <check|format> [file|-]

Read a SQL file, or stdin when file is omitted or '-'.
  check   Validate supported CREATE TABLE syntax (no database execution).
  format  Print canonical SQL to stdout; comments and formatting are discarded.

Statements require separating semicolons; the final semicolon is optional.
Input files are never modified. Unsupported syntax is an error.
`;

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}
class InputError extends Data.TaggedError("InputError")<{ readonly message: string }> {}

const args = process.argv.slice(2);
const program = Effect.gen(function* () {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return help;
  const [command, filename = "-"] = args;
  if (
    (command !== "check" && command !== "format") ||
    args.length > 2 ||
    (filename.startsWith("-") && filename !== "-")
  ) {
    return yield* Effect.fail(
      new UsageError({ message: "Expected check or format and an optional file path." }),
    );
  }
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
  const statements = yield* schema.decode(source).pipe(
    Effect.mapError((error) => {
      const line = source.split(/\r\n|\r|\n/)[error.line - 1] ?? "";
      const prefix = line.slice(0, error.column - 1).replace(/[^\t]/g, " ");
      return new InputError({
        message: `${label}:${error.line}:${error.column}: ${error.message}\n${line}\n${prefix}^`,
      });
    }),
  );
  if (command === "check")
    return `Valid supported SQL syntax: ${statements.length} statement(s).\n`;
  const sql = yield* schema.encode(statements);
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
