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
Tables contain `columns` and `tableConstraints` arrays; use `tableConstraints: []`
when constructing a table with no table-level constraints. Optional constraint
names are stored in `name` on the corresponding constraint node.

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

## Expressions

```ts
const ast = yield* Sqlite.sqlExpression.decode("a - (b - c)");
const sql = yield* Sqlite.sqlExpression.encode(ast);
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

- One `CREATE [TEMP | TEMPORARY] TABLE [IF NOT EXISTS] name (...)` statement.
- Bare non-keyword identifiers and double-quoted, backtick or bracket identifiers.
  Output always uses escaped double quotes.
- One or more columns, with an optional `INTEGER`, `TEXT`, `REAL`, `BLOB` or
  `NUMERIC` type.
- Ordered column `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`, `CHECK`, and
  `REFERENCES` constraints, optionally named with `CONSTRAINT name`.
- Named or unnamed table-level `PRIMARY KEY`, `UNIQUE`, `CHECK`, and `FOREIGN KEY`.
  Table keys support per-column collation/order and `ON CONFLICT` actions.
- Column and composite table foreign keys, optional referenced column lists,
  `ON DELETE`/`ON UPDATE` actions, `MATCH`, and `[NOT] DEFERRABLE [INITIALLY ...]`.
  Reference options retain their original order.
- String, numeric (decimal, exponent, hexadecimal and digit separators), blob,
  NULL, current-time/date/timestamp and TRUE/FALSE literal spellings. TRUE/FALSE
  remain keywords on output so SQLite retains its contextual name resolution.
- Column references with one, two or three identifier components.
- Unary `+`, `-`, `~`, `NOT`; arithmetic `+`, `-`, `*`, `/`, `%`; concatenation `||`;
  bitwise `&`, `|`, `<<`, `>>`; comparisons `<`, `>`, `<=`, `>=`, `=`, `!=`, `IS`,
  `IS NOT`; postfix `ISNULL`, `NOTNULL`, `NOT NULL`; and logical `AND`, `OR`.
  Equality and IS DISTINCT FROM aliases normalize
  to their equivalent canonical operators.
- Defaults containing literals, signed numbers or parenthesized constant expressions;
  column-reference defaults are rejected in both directions.
- Column- and table-level `CHECK (expression)`, with nested parentheses and column references.
- Whitespace, line comments and block comments, and an optional final semicolon.

The encoder produces canonical SQL with a final semicolon. Comments, original
whitespace, keyword casing and quote style are not reconstructed. The round-trip
contract for supported, valid ASTs is `decode(encode(ast))` equal to `ast`.

This grammar deliberately requires quoting reserved words used as identifiers.
It does not implement SQLite's contextual keyword fallbacks. Unsupported syntax
fails: function calls, bind parameters, CASE, CAST, BETWEEN, IN, LIKE/GLOB/REGEXP,
expression COLLATE, JSON extract operators and subqueries are not yet
implemented. Neither are custom or parameterized types, schema-qualified table
declarations, column-level collation/conflict clauses, column PRIMARY KEY
sort order/AUTOINCREMENT, generated columns, `STRICT`, `WITHOUT ROWID`,
`AS SELECT`, or statement lists. Database semantics such as duplicate columns,
conflicting constraints and contextual name resolution remain SQLite's responsibility.

## Code layout

| Location | Responsibility |
| --- | --- |
| `src/codec` | Cursor, errors, bidirectional combinators, source maps and observability |
| `src/sqlite/lexer` | Character classes, keyword set and quoted-text scanner |
| `src/sqlite/operators` | Trivia, lexemes, keywords, punctuation and grammar helpers |
| `src/sqlite/codecs/*-literal.ts` | Separate codecs for each literal kind |
| `src/sqlite/codecs/expression` | Operator precedence, expression variants and AST types |
| `src/sqlite/codecs/expression.ts` | Recursive precedence-climbing grammar and encoder dispatch |
| `src/sqlite/codecs/column-constraint` | Separate codec for each column constraint |
| `src/sqlite/codecs/table-constraint` | Separate codecs for table keys, checks and foreign keys |
| `src/sqlite/codecs/foreign-key` | Shared reference actions and deferrability rules |
| `src/sqlite/codecs/table-definition.ts` | Column list followed by ordered table constraints |
| `src/sqlite/codecs/create-table-statement.ts` | Table grammar composed from its definition |
| `src/sqlite/index.ts` | Public API; the original `create-table.ts` and `tokens.ts` imports still work |
| `tests` | Runtime, SQLite compatibility, and compile-only type checks |
| `examples/create-table.ts` | Executable example with JSON logging |

See [architecture notes](docs/architecture.md) for combinator contracts, the
relationship to the earlier experiments, and the next implementation steps.
