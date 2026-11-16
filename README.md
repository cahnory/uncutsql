# uncutsql — Effect foundation

A new implementation of uncutsql with a bidirectional SQL grammar and composable
Effect operations. This is a foundation and a small SQLite grammar, not yet the
schema diff or migration application from `../uncutsql`.

## Run

Requires Node **24.11+** and pnpm **12.4.2**. Dependencies are locked; Effect is
pinned to **4.1.4**. TypeScript runs directly through Node's type stripping.

```sh
pnpm install
pnpm check
pnpm test
pnpm demo
```

`check` includes compile-only inference tests. Runtime tests cover both codec
directions, failure semantics, source locations, concurrent execution, service
Layers and custom logging. Selected SQL fixtures were copied unchanged from the
previous implementation; tests also compare their schemas with Node's built-in
SQLite. Node may print an experimental SQLite warning when running those tests.

## Parse and serialize

```ts
import { Effect } from "effect";
import { Sqlite } from "./src/index.ts";

const program = Effect.gen(function* () {
  const ast = yield* Sqlite.createTable.decode(`
    create table users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'O''Brien'
    )
  `);
  return yield* Sqlite.createTable.encode(ast);
});

const sql = await Effect.runPromise(program);
// CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'O''Brien');
```

All library operations return Effects. Only the application boundary runs them.
Errors are `ParseError` or `EncodeError` in the typed error channel. Custom codecs
can add their own errors and services.

The AST can also be constructed directly using `Sqlite.CreateTable`; source
metadata is never required for encoding. Constraints stay in their original
order. An absent column type is represented by `typeName: undefined`.

Use `Sqlite.createTable.decodeWithSourceMap(sql)` for `{ value, source, sourceMap }`.
The source map is a separate nested tree of named syntax spans with zero-based,
end-exclusive UTF-16 offsets. Parse errors additionally carry one-based line and
column numbers, expectations and commitment status.

## Compose logging

```ts
import { Effect, Logger, References } from "effect";
import { Codec, Sqlite } from "./src/index.ts";
import { trivia } from "./src/sqlite/tokens.ts";

const sql = Codec.document(
  Codec.observe("sqlite.createTable", Sqlite.createTableGrammar),
  trivia,
);

const program = sql.decode("CREATE TABLE t (id INTEGER)").pipe(
  Effect.annotateLogs({ filename: "schema.sql" }),
  Effect.provideService(References.MinimumLogLevel, "Debug"),
  Effect.provide(Logger.layer([Logger.consoleJson])),
);

await Effect.runPromise(program);
```

`observe` adds spans and successful-operation debug events without logging source
SQL or AST contents. The caller supplies loggers, levels and tracing exporters.
It can wrap a whole grammar or individual rules. For application-level events,
compose `Effect.tap`, `Effect.tapError`, and `Effect.log` directly.

## Supported SQLite slice

- One `CREATE [TEMP | TEMPORARY] TABLE [IF NOT EXISTS] name (...)` statement.
- Bare non-keyword identifiers and double-quoted, backtick or bracket identifiers.
  Output always uses escaped double quotes.
- One or more columns, with an optional `INTEGER`, `TEXT`, `REAL`, `BLOB` or
  `NUMERIC` type.
- Ordered column `PRIMARY KEY`, `NOT NULL`, `UNIQUE` and `DEFAULT` constraints.
- Defaults containing a single-quoted string or `NULL`.
- Whitespace, line comments and block comments, and an optional final semicolon.

The encoder produces canonical SQL with a final semicolon. Comments, original
whitespace, keyword casing and quote style are not reconstructed. The round-trip
contract for supported, valid ASTs is `decode(encode(ast))` equal to `ast`.

This grammar deliberately requires quoting reserved words used as identifiers.
It does not implement SQLite's contextual keyword fallbacks. Unsupported syntax
fails: numeric/expression defaults, custom or parameterized types, schema-qualified
names, table constraints, foreign keys, `STRICT`, `WITHOUT ROWID`, `AS SELECT`,
and statement lists are not implemented yet. Syntax parsing does not validate
database semantics such as duplicate columns or conflicting constraints.

## Code layout

| Location | Responsibility |
| --- | --- |
| `src/codec` | Cursor, errors, bidirectional combinators, source maps and observability |
| `src/sqlite/tokens.ts` | SQLite lexical rules and canonical token printing |
| `src/sqlite/create-table.ts` | Composed SQL grammar and inferred semantic types |
| `tests` | Runtime, SQLite compatibility, and compile-only type checks |
| `examples/create-table.ts` | Executable example with JSON logging |

See [architecture notes](docs/architecture.md) for combinator contracts, the
relationship to the earlier experiments, and the next implementation steps.
