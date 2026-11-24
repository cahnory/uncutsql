#!/usr/bin/env node
import { readFile, writeFile, readdir, stat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Data, Effect, Result } from "effect";
import { SchemaDiffError, MigrationDecisionError, prepareMigrationDecisions } from "@uncutsql/core";
import { ParseError } from "@uncutsql/codec";
import type { Dialect, MigrationDecisions } from "@uncutsql/core";
import { parseOptions, resolveConfig, UsageError } from "./config.ts";
import { loadDialect, loadDriver } from "./plugins.ts";
import { applyGenerated } from "./apply.ts";
import { migrationFilename } from "./lock.ts";
import {
  compareGeneratedSchema,
  generateMigration,
  prepareGeneratedDecisions,
} from "./generate.ts";
import { compareSchemas, renderMigration } from "./workflow.ts";

const decisionDocument = async (document: MigrationDecisions, output?: string) => {
  const directory = await realpath(output === undefined ? process.cwd() : dirname(resolve(output)));
  const schemaPath = "node_modules/@uncutsql/cli/schemas/decisions.schema.json";
  let root = directory;
  let schema = resolve(process.cwd(), schemaPath);
  // Keep the node_modules path instead of resolving the package's symlink.
  while (true) {
    const candidate = join(root, schemaPath);
    try {
      if ((await stat(candidate)).isFile()) {
        schema = candidate;
        break;
      }
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  const path = relative(directory, schema).split(sep).join("/");
  return { $schema: path.startsWith(".") ? path : `./${path}`, ...document };
};

const help = `Usage: pnpm cli <check|format> [file|-]
       pnpm cli diff [schema-path|-]
       pnpm cli <diff|decisions|migration> <before-file|-> <after-file|->
       pnpm cli generate [schema-path|-] [output-dir]
       pnpm cli apply <database-target> [output-dir]

Options: --config <file>, --dialect <module>, --driver <module>
         --schema <path|->, --migrations <directory>
         --decisions <file>, --write-decisions [new-file] (migration/generate)
Positional paths override flags; flags override configuration. Drivers are loaded only for apply.

Schema paths accept files or directories of **/*.uncut.sql in sorted path order.
check, format and generate use config.schema when the path is omitted.
Use '-' for stdin. Without config.schema, check and format default to stdin.
generate and apply use config.migrations unless an output directory is supplied.
Decisions default to config.decisions or uncutsql.decisions.json beside the config
(working directory without config). --write-decisions may omit its path.
  check   Validate syntax supported by the selected dialect (no execution).
  format  Print canonical SQL to stdout; comments and formatting are discarded.
  diff    Compare the configured schema (or one path) to the migration lock.
          Two paths compare SQL schemas directly. No command defaults to diff.
          A missing baseline is an empty schema. Output is JSON.
          At most one input may be stdin. Changes still exit successfully.
  decisions  Print unresolved migration choices as JSON (before -> after).
  migration  Print a transaction script for supported changes; never execute it.
  generate   Write the next migration and schema lock (default directory: migrations).
  apply      Apply pending files to a database and record applied history.

Statements require separating semicolons; the final semicolon is optional.
Input SQL files are never modified. Unsupported syntax is an error.
`;

class InputError extends Data.TaggedError("InputError")<{ readonly message: string }> {}

const readFileWith = (dialect: Dialect<unknown, unknown>, filename: string) =>
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

const readSchemaWith = (dialect: Dialect<unknown, unknown>, path: string) =>
  Effect.gen(function* () {
    if (path === "-") return yield* readFileWith(dialect, path);
    const files = yield* Effect.tryPromise({
      try: async () => {
        if (!(await stat(path)).isDirectory()) return [path];
        const entries = await readdir(path, { recursive: true, withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".uncut.sql"))
          .map((entry) => join(entry.parentPath, entry.name))
          .sort();
      },
      catch: (cause) => new InputError({ message: `${path}: ${String(cause)}` }),
    });
    if (!files.length)
      return yield* Effect.fail(
        new InputError({ message: `${path}: no *.uncut.sql schema files found` }),
      );
    if (files.length === 1) return yield* readFileWith(dialect, files[0]!);
    if (!dialect.combineSchemas)
      return yield* Effect.fail(
        new InputError({ message: `Dialect ${dialect.name} does not support multipart schemas` }),
      );
    const parts = yield* Effect.forEach(files, (file) => readFileWith(dialect, file));
    return dialect.combineSchemas(parts);
  });

const validPath = (value: string) => !value.startsWith("-") || value === "-";
const program = Effect.gen(function* () {
  const { args, options } = yield* parseOptions(process.argv.slice(2));
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return help;
  const [command = "diff", filename = "-"] = args;
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
  const selected = yield* resolveConfig(options, process.cwd());
  const decisionOutput =
    options.writeDecisions === true ? selected.decisions : options.writeDecisions;
  const decisions: unknown =
    (command !== "generate" && command !== "migration") || options.writeDecisions
      ? undefined
      : yield* Effect.tryPromise({
          try: async () => {
            let source: string;
            try {
              source = await readFile(selected.decisions, "utf8");
            } catch (cause) {
              if (
                !selected.decisionsRequired &&
                cause !== null &&
                typeof cause === "object" &&
                "code" in cause &&
                cause.code === "ENOENT"
              )
                return undefined;
              throw cause;
            }
            return JSON.parse(source);
          },
          catch: (cause) =>
            new InputError({
              message: `Cannot read decisions ${selected.decisions}: ${String(cause)}`,
            }),
        });
  const writeDecisions = (document: MigrationDecisions) =>
    Effect.tryPromise({
      try: async () => {
        await writeFile(
          decisionOutput!,
          JSON.stringify(await decisionDocument(document, decisionOutput), null, 2) + "\n",
          {
            flag: "wx",
          },
        );
        const rename = document.decisions.some((item) => item.candidates.length)
          ? " or rename with a target from candidates"
          : "";
        return `Wrote ${decisionOutput}. Set resolution.action to drop_if_empty or drop${rename}, then rerun without --write-decisions (use --decisions with this path if it differs from the configured/default file).\n`;
      },
      catch: (cause) =>
        new InputError({ message: `Cannot create decision file: ${String(cause)}` }),
    });
  // Apply only needs the driver's dialect ID; it does not load a SQL parser.
  const dialect = command === "apply" ? undefined : yield* loadDialect(selected.dialect);
  const readSchema = (path: string) => readSchemaWith(dialect!, path);
  if (command === "apply") {
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
    const directory = args[2] ?? selected.migrations ?? "migrations";
    if (
      (!args[1] && !selected.schema) ||
      args.length > 3 ||
      !validPath(filename) ||
      directory.startsWith("-")
    ) {
      return yield* Effect.fail(
        new UsageError({
          message: "generate requires a schema path (or -) and an optional output directory.",
        }),
      );
    }
    const ast = yield* readSchema(args[1] ?? selected.schema!);
    if (options.writeDecisions)
      return yield* writeDecisions(yield* prepareGeneratedDecisions(dialect!, ast, directory));
    const result = yield* generateMigration(dialect!, ast, directory, decisions);
    return result.migrationPath
      ? `Generated ${result.migrationPath}\nUpdated ${result.lockPath}\n`
      : "No schema changes.\n";
  }
  if (command === "diff" && args.length <= 2) {
    const path = args[1] ?? selected.schema;
    if (!path || !validPath(path))
      return yield* Effect.fail(
        new UsageError({
          message: "diff requires a schema path or config.schema (or --schema).",
        }),
      );
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
    if (command === "decisions")
      return (
        JSON.stringify(
          yield* prepareMigrationDecisions(comparison.before, comparison.after).pipe(
            Effect.flatMap((document) => Effect.promise(() => decisionDocument(document))),
          ),
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
  const statements = yield* readSchema(args[1] ?? selected.schema ?? "-");
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
      "Use --write-decisions [new-file] to prepare choices; edit resolution fields, then rerun without --write-decisions. No migration was generated.\n",
    );
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
