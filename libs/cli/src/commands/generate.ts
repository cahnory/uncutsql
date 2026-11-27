import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { resolveConfig, UsageError } from "../config.ts";
import { readDecisions, writeDecisions } from "../decision-file.ts";
import { generateMigration, prepareGeneratedDecisions } from "../generate.ts";
import { loadDialect } from "../plugins.ts";
import { reportCommand } from "../prompts/conversation.ts";
import { promptDecisions } from "../prompts/generate.ts";
import { readSchemaWith } from "../schema-input.ts";
import { style } from "../terminal.ts";
import { decisionFlags, selectWriter } from "./decision-flags.ts";
import { outputDirectory, root, schemaPath } from "./shared.ts";

const inputs = {
  ...decisionFlags,
  interactive: Flag.Boolean("interactive").pipe(
    Flag.withoutNegation,
    Flag.withDescription("Review migration choices interactively."),
    Flag.withDefault(false),
  ),
  // Positionals are consumed in declaration order.
  schema: schemaPath,
  targetDirectory: outputDirectory,
};

const resolveGenerate = (input: Command.Command.Config.Infer<typeof inputs>) =>
  Effect.gen(function* () {
    const writer = yield* selectWriter(input);
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
    yield* reportCommand(
      review.mode === "interactive" ? "Generate migration" : undefined,
      Effect.gen(function* () {
        const reviewed =
          review.mode === "interactive"
            ? yield* promptDecisions(
                yield* prepareGeneratedDecisions(dialect, ast, directory),
                dialect.supportsDropGuards === true,
              )
            : yield* readDecisions(review);
        const result = yield* generateMigration(dialect, ast, directory, reviewed);
        return result.migrationPath
          ? `${style("green", "Generated", process.stdout)} ${result.migrationPath}\n${style("cyan", "Updated", process.stdout)} ${result.lockPath}`
          : "No schema changes.";
      }),
    );
  }),
).pipe(
  Command.withDescription("Write the next migration and update the schema lock."),
  Command.withExamples([{ command: "uncutsql generate schema.sql migrations" }]),
);
