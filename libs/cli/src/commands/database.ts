import { Console, Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { adoptGenerated, applyGenerated } from "../apply.ts";
import { compactGenerated } from "../compact.ts";
import { resolveConfig, UsageError } from "../config.ts";
import { writeExtractedSchema } from "../extract.ts";
import { baselineFilename, migrationFilename } from "../lock.ts";
import { loadDriver } from "../plugins.ts";
import { InputError } from "../schema-input.ts";
import { outputDirectory, root } from "./shared.ts";

const databaseTarget = Argument.String("database-target").pipe(
  Argument.withDescription("Database target to open with the selected driver."),
  Argument.withSchema(
    Schema.String.check(Schema.isPattern(/^[^-]/, { expected: "a database target" })),
  ),
);
const migrationNumber = Argument.String("N").pipe(
  Argument.withDescription("Migration number in the existing history."),
  Argument.withSchema(
    Schema.String.check(Schema.isPattern(/^\d+$/, { expected: "a decimal migration number" })),
  ),
  Argument.map(Number),
  Argument.withSchema(Schema.Int),
);

const migrationContext = (outputDirectory: string | undefined) =>
  Effect.gen(function* () {
    const config = yield* resolveConfig(yield* root, process.cwd());
    const directory = outputDirectory ?? config.migrations ?? "migrations";
    if (directory.startsWith("-")) {
      return yield* new UsageError({ message: "Expected a migration directory." });
    }
    const driver = yield* loadDriver(config.driver);
    return { directory, driver };
  });

const executionInputs = { databaseTarget, outputDirectory };
const execute =
  (direction: "up" | "down") =>
  ({ databaseTarget, outputDirectory }: Command.Command.Config.Infer<typeof executionInputs>) =>
    Effect.gen(function* () {
      const { directory, driver } = yield* migrationContext(outputDirectory);
      const result = yield* applyGenerated(driver, databaseTarget, directory, direction);
      if (direction === "down") {
        return yield* Console.log(
          result.rolledBackId === undefined
            ? "No applied migrations."
            : `Rolled back ${migrationFilename(result.rolledBackId)}.`,
        );
      }
      const files = result.appliedIds.map((id) =>
        id === result.baselineId ? baselineFilename(id) : migrationFilename(id),
      );
      yield* Console.log(files.length ? `Applied ${files.join(", ")}.` : "Database is up to date.");
    });

const applyPending = execute("up");
const applyDescription = "Apply pending files to a database and record applied history.";
export const apply = Command.make("apply", executionInputs, applyPending).pipe(
  Command.withDescription(applyDescription),
  Command.withExamples([{ command: "uncutsql apply project.sqlite" }]),
);
export const up = Command.make("up", executionInputs, applyPending).pipe(
  Command.withDescription(applyDescription),
  Command.withExamples([{ command: "uncutsql up project.sqlite" }]),
);
export const down = Command.make("down", executionInputs, execute("down")).pipe(
  Command.withDescription("Roll back the most recently applied migration."),
  Command.withExamples([{ command: "uncutsql down project.sqlite" }]),
);

export const adopt = Command.make(
  "adopt",
  { databaseTarget, migrationNumber, outputDirectory },
  ({ databaseTarget, migrationNumber, outputDirectory }) =>
    Effect.gen(function* () {
      const { directory, driver } = yield* migrationContext(outputDirectory);
      yield* adoptGenerated(driver, databaseTarget, directory, migrationNumber);
      yield* Console.log(`Initialized database history through migration ${migrationNumber}.`);
    }),
).pipe(
  Command.withDescription(
    "Verify an existing database at migration N and initialize its migration history.",
  ),
  Command.withExamples([{ command: "uncutsql adopt project.sqlite 2" }]),
);

export const compact = Command.make(
  "compact",
  {
    migrationNumber,
    outputDirectory,
    yes: Flag.Boolean("yes").pipe(
      Flag.withoutNegation,
      Flag.withDescription("Confirm deletion of the superseded migration files."),
      Flag.withDefault(false),
    ),
  },
  ({ migrationNumber, outputDirectory, yes }) =>
    Effect.gen(function* () {
      const { directory, driver } = yield* migrationContext(outputDirectory);
      const done = yield* compactGenerated(driver, directory, migrationNumber, yes);
      yield* Console.log(
        done ? `Compacted migrations 1 through ${migrationNumber}.` : "Compaction cancelled.",
      );
    }),
).pipe(
  Command.withDescription("Replace migrations 1 through N with a baseline."),
  Command.withExamples([{ command: "uncutsql compact 3" }]),
);

export const extract = Command.make(
  "extract",
  {
    databaseTarget,
    destination: Argument.String("schema-path").pipe(
      Argument.withDescription("Write the schema to a file, directory, or stdout (-)."),
      Argument.withDefault(undefined),
    ),
  },
  ({ databaseTarget, destination }) =>
    Effect.gen(function* () {
      const config = yield* resolveConfig(yield* root, process.cwd());
      const path = destination ?? config.schema ?? "-";
      if (path !== "-" && path.startsWith("-")) {
        return yield* new UsageError({ message: "Expected a schema destination or - for stdout." });
      }
      const driver = yield* loadDriver(config.driver);
      if (!driver.extract) {
        return yield* new InputError({ message: "Driver does not support schema extraction." });
      }
      const parts = yield* driver.extract(databaseTarget);
      if (path === "-") {
        process.stdout.write(parts.map((part) => part.sql).join("\n"));
        return;
      }
      yield* Effect.tryPromise({
        catch: (cause) => new InputError({ message: String(cause) }),
        try: () => writeExtractedSchema(databaseTarget, path, parts),
      });
      yield* Console.log(
        parts.length
          ? `Extracted schema to ${path}.\nFor an untracked database, generate the first migration from this schema, then run adopt at migration 1. If migrations already exist, use adopt with the matching migration number.`
          : `Extracted empty schema to ${path}.`,
      );
    }),
).pipe(
  Command.withDescription("Export the database schema to a file, directory, or stdout."),
  Command.withExamples([{ command: "uncutsql extract project.sqlite -" }]),
);
