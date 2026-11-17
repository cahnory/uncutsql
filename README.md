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
pnpm build
```

`check` runs formatting, lint, package tests and TypeScript checks, including
compile-only inference tests. Runtime tests cover both codec
directions, failure semantics, source locations, concurrent execution, service
Layers and custom logging. Selected SQL fixtures were copied unchanged from the
previous implementation; tests also compare their schemas with Node's built-in
SQLite. Node may print an experimental SQLite warning when running those tests.

## Workspace

- `libs/codec` — `@uncutsql/codec`, the generic Effect codec library.
- `libs/sqlite` — `@uncutsql/sqlite`, depending on the codec via `workspace:*`.
- `apps/demo` — `@uncutsql/demo`, an executable consumer of both libraries.

Each library owns its tests; SQLite fixtures stay beside its tests. Shared
TypeScript settings live in `tsconfig.base.json` and `tsconfig.node.json`.
Workspace exports resolve to TypeScript source so tests and the demo work without
building first. `pnpm build` builds libraries in dependency order with tsdown,
producing ESM, CommonJS and declarations in each library's `dist` directory.
Packages remain private; build configuration includes distribution export maps.

Use `pnpm --filter @uncutsql/sqlite check` to check one library,
`pnpm check:types` for workspace type checks, and `pnpm fix:format` to format.
The root `pnpm test` alias still runs all runtime tests.

## Parse and serialize

```ts
import { Effect } from "effect";
import * as Sqlite from "@uncutsql/sqlite";

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
Tables contain `columns` and `tableConstraints` arrays; use `tableConstraints: []`
when constructing a table with no table-level constraints. Optional constraint
names are stored in `name` on the corresponding constraint node. Optional
`schema` qualifies the table name without changing `name`; omitted schemas remain
implicit. Optional table `options` retain the ordered `"STRICT"` / `"WITHOUT ROWID"` spellings.
`typeName` is validated SQL text: quoted words and internal trivia are retained
because their spelling can affect SQLite's declared type and affinity.

Use `Sqlite.createTable.decodeWithSourceMap(sql)` for `{ value, source, sourceMap }`.
The source map is a separate nested tree of named syntax spans with zero-based,
end-exclusive UTF-16 offsets. Parse errors additionally carry one-based line and
column numbers, expectations and commitment status.

## Compose logging

```ts
import { Effect, Logger, References } from "effect";
import * as Codec from "@uncutsql/codec";
import * as Sqlite from "@uncutsql/sqlite";
import { trivia } from "@uncutsql/sqlite/tokens";

const sql = Codec.document(Codec.observe("sqlite.createTable", Sqlite.createTableGrammar), trivia);

const program = sql
  .decode("CREATE TABLE t (id INTEGER)")
  .pipe(
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

## Expressions

```ts
const ast = yield * Sqlite.sqlExpression.decode("a - (b - c)");
const sql = yield * Sqlite.sqlExpression.encode(ast);
// "a" - ("b" - "c")
```

`Sqlite.expression` is the composable grammar; `Sqlite.sqlExpression` is its
whole-document entry point. The parser and encoder share SQLite's precedence
table. Parentheses shape the semantic tree and remain in the source map; the
encoder inserts the parentheses required to preserve that tree. Equal-precedence
right children stay grouped even for addition and multiplication.

Numeric literals use `{ _tag: "NumericLiteral", value: "9007199254740993" }`.
The value is SQL text, not a JavaScript number: this preserves large integers and
the difference between INTEGER and REAL expressions such as `1 / 2` and `1.0 / 2`.
Signs are unary-expression nodes. Blob values contain hexadecimal byte pairs.

## Supported SQLite slice

- One `CREATE [TEMP | TEMPORARY] TABLE [IF NOT EXISTS] [schema.]name (...)` statement.
- Bare non-keyword identifiers and double-quoted, backtick or bracket identifiers.
  Output always uses escaped double quotes.
- One or more columns, with optional custom, multiword or parameterized types.
  Type parameters accept one or two signed numeric literals.
- Ordered column `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`, `CHECK`, and
  `REFERENCES`, `COLLATE`, and generated-column constraints, optionally named
  with `CONSTRAINT name`. Column keys support sort order and `AUTOINCREMENT`;
  PRIMARY KEY, NOT NULL and UNIQUE support `ON CONFLICT` actions.
- `[GENERATED ALWAYS] AS (expression) [VIRTUAL | STORED]` columns.
- Comma-separated `STRICT` and `WITHOUT ROWID` table options.
- Named or unnamed table-level `PRIMARY KEY`, `UNIQUE`, `CHECK`, and `FOREIGN KEY`.
  Table keys support per-column collation/order and `ON CONFLICT` actions.
- Column and composite table foreign keys, optional referenced column lists,
  `ON DELETE`/`ON UPDATE` actions, `MATCH`, and `[NOT] DEFERRABLE [INITIALLY ...]`.
  Reference options retain their original order.
- String, numeric (decimal, exponent, hexadecimal and digit separators), blob,
  NULL, current-time/date/timestamp and TRUE/FALSE literal spellings. TRUE/FALSE
  remain keywords on output so SQLite retains its contextual name resolution.
- Column references with one, two or three identifier components.
- Ordinary function calls with zero or more expression arguments, including nested calls.
  Function names use identifier syntax and are quoted on output. Aggregate modifiers
  (`DISTINCT`, `*`, argument ordering), FILTER and OVER are not supported.
- Unary `+`, `-`, `~`, `NOT`; arithmetic `+`, `-`, `*`, `/`, `%`; concatenation `||`;
  bitwise `&`, `|`, `<<`, `>>`; comparisons `<`, `>`, `<=`, `>=`, `=`, `!=`, `IS`,
  `IS NOT`; postfix `ISNULL`, `NOTNULL`, `NOT NULL`; and logical `AND`, `OR`.
  Equality and IS DISTINCT FROM aliases normalize
  to their equivalent canonical operators.
- `BETWEEN` and `NOT BETWEEN` range expressions, including nested bounds.
- `IN` and `NOT IN` with parenthesized expression lists, including empty lists.
  Subquery, table-name and table-function targets are not implemented.
- Defaults containing literals, signed numbers or parenthesized constant expressions;
  column-reference defaults are rejected in both directions.
- Column- and table-level `CHECK (expression)`, with nested parentheses and column references.
- Whitespace, line comments and block comments, and an optional final semicolon.

The encoder produces canonical SQL with a final semicolon. Comments, original
whitespace, keyword casing and quote style are not reconstructed, except within
type declarations where the original spelling is significant. The round-trip
contract for supported, valid ASTs is `decode(encode(ast))` equal to `ast`.

This grammar deliberately requires quoting reserved words used as identifiers.
The built-in `temp` schema is accepted unquoted before a dot; other contextual
keyword fallbacks are not implemented. Unsupported syntax
fails: bind parameters, CASE, CAST, LIKE/GLOB/REGEXP,
expression COLLATE, JSON extract operators and subqueries are not yet
implemented. Neither are `AS SELECT` or statement lists. Database semantics such as duplicate columns,
conflicting constraints and contextual name resolution remain SQLite's responsibility.

## Code layout

| Location                                                    | Responsibility                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `libs/codec/src`                                            | Cursor, errors, bidirectional combinators, source maps and observability |
| `libs/sqlite/src/lexer`                                     | Character classes, keyword set and quoted-text scanner                   |
| `libs/sqlite/src/operators`                                 | Trivia, lexemes, keywords, punctuation and grammar helpers               |
| `libs/sqlite/src/codecs/*-literal.ts`                       | Separate codecs for each literal kind                                    |
| `libs/sqlite/src/codecs/expression`                         | Operator precedence, expression variants and AST types                   |
| `libs/sqlite/src/codecs/expression.ts`                      | Recursive precedence-climbing grammar and encoder dispatch               |
| `libs/sqlite/src/codecs/column-constraint`                  | Separate codec for each column constraint                                |
| `libs/sqlite/src/codecs/table-constraint`                   | Separate codecs for table keys, checks and foreign keys                  |
| `libs/sqlite/src/codecs/foreign-key`                        | Shared reference actions and deferrability rules                         |
| `libs/sqlite/src/codecs/type-name.ts` / `type-parameter.ts` | Validated type declarations and numeric dimensions                       |
| `libs/sqlite/src/codecs/table-options.ts`                   | Ordered STRICT / WITHOUT ROWID options                                   |
| `libs/sqlite/src/codecs/table-reference.ts`                 | Optional schema qualifier and table name                                 |
| `libs/sqlite/src/codecs/table-definition.ts`                | Column list followed by ordered table constraints                        |
| `libs/sqlite/src/codecs/create-table-statement.ts`          | Table grammar composed from its definition                               |
| `libs/sqlite/src/index.ts`                                  | Public API with `@uncutsql/sqlite/create-table` and `/tokens` subpaths   |
| `libs/*/tests`                                              | Runtime, SQLite compatibility, and compile-only type checks              |
| `apps/demo/src/index.ts`                                    | Executable example with JSON logging                                     |

See [architecture notes](docs/architecture.md) for combinator contracts, the
relationship to the earlier experiments, and the next implementation steps.
