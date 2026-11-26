import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";

import { Data, Effect } from "effect";

import { ParseError } from "@uncutsql/codec";
import type { Dialect } from "@uncutsql/core";

import { schemaFiles } from "./schema-files.ts";
import { style } from "./terminal.ts";

export class InputError extends Data.TaggedError("InputError")<{ readonly message: string }> {}

const readFileWith = (dialect: Dialect<unknown, unknown>, filename: string, stdin: Readable) =>
  Effect.gen(function* () {
    const label = filename === "-" ? "<stdin>" : filename;
    const source = yield* Effect.tryPromise({
      catch: (cause) =>
        new InputError({
          message: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      try: async () => {
        if (filename !== "-") {
          return await readFile(filename, "utf8");
        }
        stdin.setEncoding("utf8");
        let input = "";
        for await (const chunk of stdin) {
          input += chunk;
        }
        return input;
      },
    });
    return yield* dialect.parse(source).pipe(
      Effect.mapError((error) => {
        if (!(error instanceof ParseError)) {
          return new InputError({ message: `${label}: ${error.message}` });
        }
        const line = source.split(/\r\n|\r|\n/)[error.line - 1] ?? "";
        const prefix = line.slice(0, error.column - 1).replace(/[^\t]/g, " ");
        return new InputError({
          message: `${style("bold", `${label}:${error.line}:${error.column}`)}: ${error.message}\n${line}\n${prefix}${style("red", "^")}`,
        });
      }),
    );
  });

export const readSchemaWith = (dialect: Dialect<unknown, unknown>, path: string, stdin: Readable) =>
  Effect.gen(function* () {
    if (path === "-") {
      return yield* readFileWith(dialect, path, stdin);
    }
    const files = yield* Effect.tryPromise({
      catch: (cause) => new InputError({ message: `${path}: ${String(cause)}` }),
      try: () => schemaFiles(path),
    });
    if (!files.length) {
      return yield* Effect.fail(
        new InputError({ message: `${path}: no *.uncut.sql schema files found` }),
      );
    }
    if (files.length === 1) {
      return yield* readFileWith(dialect, files[0]!, stdin);
    }
    if (!dialect.combineSchemas) {
      return yield* Effect.fail(
        new InputError({ message: `Dialect ${dialect.name} does not support multipart schemas` }),
      );
    }
    const parts = yield* Effect.forEach(files, (file) => readFileWith(dialect, file, stdin));
    return dialect.combineSchemas(parts);
  });
