import { Array, Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { resolveConfig, UsageError } from "../config.ts";
import type { DecisionWriterFlag } from "../config.ts";
import { readDecisions, writeDecisions } from "../decision-file.ts";
import { generateMigration, prepareGeneratedDecisions } from "../generate.ts";
import { promptDecisions } from "../interactive.ts";
import { loadDialect } from "../plugins.ts";
import { readSchemaWith } from "../schema-input.ts";
import { style } from "../terminal.ts";
import { outputDirectory, root } from "./shared.ts";

const writer = (flag: DecisionWriterFlag, description: string) =>
  Flag.String(flag.slice(2)).pipe(
    Flag.withOptionalValue(""),
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.map((path) => ({ flag, path: path || undefined }))),
  );

const inputs = {
  decisions: Flag.String("decisions").pipe(
    Flag.withDescription("Read reviewed decisions from this file."),
    Flag.withDefault(undefined),
  ),
  interactive: Flag.Boolean("interactive").pipe(
    Flag.withoutNegation,
    Flag.withDescription("Review migration choices interactively."),
    Flag.withDefault(false),
  ),
  merge: writer("--merge-decisions", "Refresh the file and keep applicable decisions."),
  rewrite: writer("--rewrite-decisions", "Reset current decisions to pending."),
  // Positionals are consumed in declaration order.
  schema: Argument.String("schema-path").pipe(
    Argument.withDescription("Read SQL from a file, directory, or stdin (-)."),
    Argument.withDefault(undefined),
  ),
  targetDirectory: outputDirectory,
  write: writer("--write-decisions", "Create a new decision file."),
};

const resolveGenerate = (input: Command.Command.Config.Infer<typeof inputs>) =>
  Effect.gen(function* () {
    const writers = Array.getSomes([input.write, input.rewrite, input.merge]);
    const writer = writers[0];
    if (writers.length > 1 || (writer && input.decisions !== undefined)) {
      return yield* new UsageError({ message: "Choose only one decision-file option." });
    }
    if (input.interactive && (input.decisions !== undefined || writer)) {
      return yield* new UsageError({
        message:
          "--interactive requires generate and cannot be combined with decision-file options.",
      });
    }
    const selected = yield* resolveConfig(
      { ...(yield* root), decisions: input.decisions },
      process.cwd(),
    );
    const path = input.schema ?? selected.schema;
    const directory = input.targetDirectory ?? selected.migrations ?? "migrations";
    if (!path || (path !== "-" && path.startsWith("-")) || directory.startsWith("-")) {
      return yield* new UsageError({
        message: "generate requires a schema path (or -) and an optional output directory.",
      });
    }
    if (input.interactive && path === "-") {
      return yield* new UsageError({
        message:
          "--interactive reads answers from stdin. Supply the schema as a file or directory.",
      });
    }

    const review = writer
      ? { flag: writer.flag, mode: "write" as const, path: writer.path ?? selected.decisions }
      : input.interactive
        ? { mode: "interactive" as const }
        : {
            decisions: selected.decisions,
            decisionsRequired: selected.decisionsRequired,
            mode: "read" as const,
          };
    return { dialect: selected.dialect, directory, path, review };
  });

export const generate = Command.make("generate", inputs, (input) =>
  Effect.gen(function* () {
    const { dialect: plugin, directory, path, review } = yield* resolveGenerate(input);
    const dialect = yield* loadDialect(plugin);
    const ast = yield* readSchemaWith(dialect, path, process.stdin);
    if (review.mode === "write") {
      const fresh = yield* prepareGeneratedDecisions(dialect, ast, directory);
      const message = yield* writeDecisions(fresh, review.path, review.flag);
      return yield* Console.log(message.trimEnd());
    }
    const reviewed =
      review.mode === "interactive"
        ? yield* promptDecisions(
            yield* prepareGeneratedDecisions(dialect, ast, directory),
            dialect.supportsDropGuards === true,
          )
        : yield* readDecisions(review);
    const result = yield* generateMigration(dialect, ast, directory, reviewed);
    yield* Console.log(
      result.migrationPath
        ? `${style("green", "Generated", process.stdout)} ${result.migrationPath}\n${style("cyan", "Updated", process.stdout)} ${result.lockPath}`
        : "No schema changes.",
    );
  }),
).pipe(
  Command.withDescription("Write the next migration and update the schema lock."),
  Command.withExamples([{ command: "uncutsql generate schema.sql migrations" }]),
);
