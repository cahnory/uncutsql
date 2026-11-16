import { Effect, Logger, References } from "effect";
import { document, observe } from "../src/codec/index.ts";
import { createTableGrammar } from "../src/sqlite/index.ts";
import { trivia } from "../src/sqlite/tokens.ts";

const sql = document(observe("sqlite.createTable", createTableGrammar), trivia);

const program = Effect.gen(function* () {
  const ast = yield* sql.decode(`
    -- Comments and keyword casing are normalized.
    create table if not exists users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'O''Brien'
    )
  `);
  yield* Effect.log("Parsed table", { name: ast.name, columns: ast.columns.length });
  const encoded = yield* sql.encode(ast);
  yield* Effect.log("Canonical SQL", encoded);
}).pipe(
  Effect.annotateLogs({ example: "create-table" }),
  Effect.provideService(References.MinimumLogLevel, "Debug"),
  Effect.provide(Logger.layer([Logger.consoleJson])),
);

await Effect.runPromise(program);
