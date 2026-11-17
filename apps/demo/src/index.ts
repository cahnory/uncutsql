import { Effect, Logger, References } from "effect";
import { document, observe } from "@uncutsql/codec";
import { createTableGrammar } from "@uncutsql/sqlite";
import { trivia } from "@uncutsql/sqlite/tokens";

const sql = document(observe("sqlite.createTable", createTableGrammar), trivia);

const program = Effect.gen(function* () {
  const ast = yield* sql.decode(`
    -- Comments and keyword casing are normalized.
    create table if not exists users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'O''Brien',
      age INTEGER DEFAULT (18 + 3) CHECK (age >= 0 AND age <= 130),
      CONSTRAINT unique_name UNIQUE (name)
    )
  `);
  console.dir(ast, { depth: Infinity });
  yield* Effect.log("Parsed table", { name: ast.name, columns: ast.columns.length });
  const encoded = yield* sql.encode(ast);
  console.dir(encoded);
  yield* Effect.log("Canonical SQL", encoded);
}).pipe(
  Effect.annotateLogs({ example: "create-table" }),
  Effect.provideService(References.MinimumLogLevel, "Debug"),
  Effect.provide(Logger.layer([Logger.consoleJson])),
);

await Effect.runPromise(program);
