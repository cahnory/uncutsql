import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { prepareMigrationDecisions, SchemaDiffError } from "@uncutsql/core";

import { resolveConfig, UsageError } from "../config.ts";
import { decisionDocument, readDecisions, writeDecisions } from "../decision-file.ts";
import { compareGeneratedSchema } from "../generate.ts";
import { loadDialect } from "../plugins.ts";
import { InputError, readSchemaWith } from "../schema-input.ts";
import { compareSchemas, renderMigration } from "../workflow.ts";
import { decisionFlags, selectWriter } from "./decision-flags.ts";
import { root, schemaPath } from "./shared.ts";

const beforePath = Argument.String("before-path").pipe(
  Argument.withDescription("Original schema file, directory, or stdin (-)."),
);
const afterPath = Argument.String("after-path").pipe(
  Argument.withDescription("New schema file, directory, or stdin (-)."),
);

const comparePair = (command: string, before: string, after: string, decisions?: string) =>
  Effect.gen(function* () {
    const valid = (path: string) => path === "-" || !path.startsWith("-");
    if (!valid(before) || !valid(after) || (before === "-" && after === "-")) {
      return yield* new UsageError({
        message: `${command} requires two paths; at most one may be stdin (-).`,
      });
    }
    const config = yield* resolveConfig({ ...(yield* root), decisions }, process.cwd());
    const dialect = yield* loadDialect(config.dialect);
    const original = yield* readSchemaWith(dialect, before, process.stdin);
    const next = yield* readSchemaWith(dialect, after, process.stdin);
    const comparison = yield* compareSchemas(dialect, original, next).pipe(
      Effect.mapError(
        (error) =>
          new InputError({
            message:
              error instanceof SchemaDiffError
                ? error.diagnostics
                    .map((item) => `${item.side === "before" ? before : after}: ${item.message}`)
                    .join("\n")
                : error.message,
          }),
      ),
    );
    return { comparison, config, dialect };
  });

export const diffAgainstLock = (flags: Parameters<typeof resolveConfig>[0], schema?: string) =>
  Effect.gen(function* () {
    const config = yield* resolveConfig(flags, process.cwd());
    const path = schema ?? config.schema;
    if (!path || (path.startsWith("-") && path !== "-")) {
      return yield* new UsageError({
        message: "diff requires a schema path or config.schema (or --schema).",
      });
    }
    const dialect = yield* loadDialect(config.dialect);
    const ast = yield* readSchemaWith(dialect, path, process.stdin);
    const comparison = yield* compareGeneratedSchema(
      dialect,
      ast,
      config.migrations ?? "migrations",
    );
    yield* Console.log(JSON.stringify(comparison.diff, null, 2));
  });

export const diff = Command.make(
  "diff",
  {
    schema: schemaPath,
    target: afterPath.pipe(Argument.withDefault(undefined)),
  },
  ({ schema, target }) =>
    Effect.gen(function* () {
      if (schema !== undefined && target !== undefined) {
        const { comparison } = yield* comparePair("diff", schema, target);
        return yield* Console.log(JSON.stringify(comparison.diff, null, 2));
      }
      yield* diffAgainstLock(yield* root, schema);
    }),
).pipe(
  Command.withDescription(
    "Compare a schema to the migration lock, or compare two schemas directly. Print changes as JSON.",
  ),
  Command.withExamples([
    { command: "uncutsql diff schema.sql" },
    { command: "uncutsql diff before.sql after.sql" },
  ]),
);

const paths = { source: beforePath, target: afterPath };

export const decisions = Command.make("decisions", paths, ({ source, target }) =>
  Effect.gen(function* () {
    const { comparison } = yield* comparePair("decisions", source, target);
    const fresh = yield* prepareMigrationDecisions(comparison.before, comparison.after);
    const document = yield* Effect.tryPromise({
      catch: (cause) => new InputError({ message: String(cause) }),
      try: () => decisionDocument(fresh),
    });
    yield* Console.log(JSON.stringify(document, null, 2));
  }),
).pipe(
  Command.withDescription("Print migration choices for two schemas as JSON."),
  Command.withExamples([{ command: "uncutsql decisions before.sql after.sql" }]),
);

export const migration = Command.make("migration", { ...paths, ...decisionFlags }, (input) =>
  Effect.gen(function* () {
    const writer = yield* selectWriter(input);
    const { comparison, config, dialect } = yield* comparePair(
      "migration",
      input.source,
      input.target,
      input.decisions,
    );
    if (writer) {
      const fresh = yield* prepareMigrationDecisions(comparison.before, comparison.after);
      const message = yield* writeDecisions(fresh, writer.path ?? config.decisions, writer.flag);
      return yield* Console.log(message.trimEnd());
    }
    const reviewed = yield* readDecisions(config);
    const sql = yield* renderMigration(dialect, comparison, reviewed);
    if (sql.length) {
      yield* Console.log(sql);
    }
  }),
).pipe(
  Command.withDescription("Print a migration SQL script for the changes between two schemas."),
  Command.withExamples([{ command: "uncutsql migration before.sql after.sql" }]),
);
