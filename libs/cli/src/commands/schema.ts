import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { resolveConfig, UsageError } from "../config.ts";
import { loadDialect } from "../plugins.ts";
import { readSchemaWith } from "../schema-input.ts";
import { root, schemaPath } from "./shared.ts";

const readInput = (path: string | undefined) =>
  Effect.gen(function* () {
    if (path?.startsWith("-") && path !== "-") {
      return yield* new UsageError({ message: "Expected a schema path or - for stdin." });
    }
    const config = yield* resolveConfig(yield* root, process.cwd());
    const dialect = yield* loadDialect(config.dialect);
    const statements = yield* readSchemaWith(dialect, path ?? config.schema ?? "-", process.stdin);
    return { dialect, statements };
  });

export const check = Command.make("check", { schemaPath }, ({ schemaPath }) =>
  Effect.gen(function* () {
    yield* readInput(schemaPath);
    yield* Console.log("Valid supported SQL syntax.");
  }),
).pipe(
  Command.withDescription("Validate syntax supported by the selected dialect."),
  Command.withExamples([{ command: "uncutsql check schema.sql" }]),
);

export const format = Command.make("format", { schemaPath }, ({ schemaPath }) =>
  Effect.gen(function* () {
    const { dialect, statements } = yield* readInput(schemaPath);
    const sql = yield* dialect.format(statements);
    if (sql.length) {
      yield* Console.log(sql);
    }
  }),
).pipe(
  Command.withDescription("Print canonical SQL to stdout."),
  Command.withExamples([{ command: "uncutsql format -" }]),
);
