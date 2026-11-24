# @uncutsql/sqlite

Bidirectional SQLite syntax codecs and migration rendering, built on
`@uncutsql/codec` and Effect. This package has **no database-driver dependency**.

## Progress at a glance

The current focus is **table-schema management**, not a general-purpose SQLite
query parser. Schema files support table, standalone index and view declarations. Expression support is substantial but incomplete.

| Area                   | Status                    | Current boundary                                                                                      |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lexical syntax         | Supported subset          | Comments, quoted identifiers, literals and operators; contextual keyword fallbacks remain limited     |
| Expressions            | Partial                   | Arithmetic, comparisons, calls, IN/BETWEEN, COLLATE and JSON extraction; remaining forms listed below |
| CREATE TABLE           | Supported subset          | Columns, constraints, references, generated columns and table options; including AS queries           |
| Schema files           | Supported subset          | Ordered table, index and view declarations, empty statements and optional final semicolon             |
| Queries                | Supported subset          | SELECT/VALUES, joins, compounds, subqueries and WITH/recursive CTEs                                   |
| Other input statements | Not implemented           | Other DDL, DML and administrative statements                                                          |
| AST ↔ database model   | Tables, indexes and views | Columns, constraints, options, view queries and schema identity                                       |
| Migration output       | Supported subset          | Create, drop, add column and rebuild; this is separate from input parsing                             |
| Database execution     | Separate package          | `@uncutsql/sqlite-driver` owns native SQLite access                                                   |

There is no overall syntax percentage yet: a keyword count would overstate
coverage, and a grammar-production count would give very different weights to
small clauses and entire SELECT statements. The checklists below track concrete
capabilities. **Checked means implemented within the stated limits, not complete
SQLite conformance.** Update this checklist when adding a grammar feature.

## Lexical syntax

- [x] Whitespace, `--` line comments and `/* ... */` block comments.
- [x] Bare non-keyword identifiers, including non-ASCII names.
- [x] Double-quoted, backtick-quoted and bracket-quoted identifiers; encoding uses
      escaped double quotes. Doubled closing brackets are not an escape.
- [x] String literals with doubled single quotes and hexadecimal blob literals.
- [x] Numeric literals: integers, decimals, exponents, hexadecimal and digit
      separators. SQL spelling preserves precision and INTEGER/REAL distinctions.
- [x] NULL, TRUE/FALSE and CURRENT_TIME/CURRENT_DATE/CURRENT_TIMESTAMP spellings.
- [x] Custom, multiword and parameterized type declarations. One or two signed
      numeric dimensions are accepted; digit separators in dimensions are rejected.
- [x] Bind parameters: `?`, `?NNN`, `:name`, `@name`, `$name` and extended names.
- [x] Single-quoted result and table aliases, including doubled apostrophes. Formatting emits double-quoted aliases.
- [x] Single-quoted schema and relation names in declarations and query table sources.
- [x] Single-quoted table and view column declarations and foreign key names on both sides of a reference.
- [x] Explicit result and table aliases accept SQLite contextual keywords and preserve their spelling.
- [x] Implicit result and table aliases accept unambiguous contextual keywords. Pattern operators such as `LIKE` are also valid implicit table aliases.
- [x] Distinguish implicit `WINDOW`, `FILTER` and `OVER` aliases from window syntax.
- [x] Contextual and single-quoted window names in declarations, OVER references and base windows.
- [x] Contextual schema and relation names in table declarations and query sources, including joins.
- [x] Contextual table and view column names, foreign key columns and target tables, and CREATE INDEX target tables.
- [x] Contextual and single-quoted names for column and table constraints. Consecutive labels use the last name, and formatting preserves the effective names of adjacent constraints, including across the final column and first table constraint.
- [ ] General contextual keyword fallbacks and SQLite's legacy quote reinterpretation.
      TRUE/FALSE retain their contextual expression semantics.

Most remaining work is in grammar and semantics rather than token scanning:
recognizing a keyword does not imply support for the construct it introduces.

## Expressions

- [x] Literals, parentheses and one-, two- or three-part column references.
- [x] Unary `+`, `-`, `~`, `NOT`.
- [x] Arithmetic `+`, `-`, `*`, `/`, `%`; concatenation `||`.
- [x] Bitwise `&`, `|`, `<<`, `>>`.
- [x] Comparisons `<`, `>`, `<=`, `>=`, `=`, `!=`, `IS`, `IS NOT`.
      `==`, `<>`, IS DISTINCT FROM and IS NOT DISTINCT FROM normalize to equivalents.
- [x] Postfix ISNULL, NOTNULL and NOT NULL; logical AND and OR.
- [x] BETWEEN / NOT BETWEEN, including nested bounds.
- [x] IN / NOT IN with expression lists, including empty lists.
- [x] Ordinary function calls with zero or more arguments and nested expressions.
      Function existence and arity are checked by SQLite, not by this parser.
- [x] Expression-level COLLATE, including repeated clauses and quoted names.
- [x] JSON extraction `->` / `->>`, retaining their distinct result semantics.
      Path evaluation, JSON validity and function/extension availability belong to SQLite.
- [x] LIKE / NOT LIKE with ESCAPE.
- [x] GLOB, REGEXP and MATCH, including their NOT forms.
      Extension function availability/arity and escape-character validation are runtime concerns.
- [x] CAST expressions, including nested operands and custom/parameterized types.
      Type spelling is preserved; SQLite performs the conversion.
- [x] CASE expressions, both simple and searched forms, with nesting and optional ELSE.
- [x] RAISE expressions: IGNORE and ROLLBACK/ABORT/FAIL with expression messages.
      Trigger conditions and action expressions use the same expression codec.
- [x] Aggregate syntax: `*`, DISTINCT/ALL and argument ORDER BY, with ASC/DESC
      and NULLS FIRST/LAST retained explicitly.
- [x] FILTER (WHERE expression).
- [x] OVER with named/inline windows, PARTITION BY, ORDER BY, ROWS/RANGE/GROUPS
      frames and EXCLUDE. Window-name tokens preserve significant quoting.
      Query-level WINDOW declarations are supported by `sqlQuery`.
- [x] IN/NOT IN with tables and table-valued functions, including schema qualifiers
      and empty argument lists.
- [x] Scalar/row subqueries, EXISTS/NOT EXISTS and IN/NOT IN query targets,
      including correlated SELECT, VALUES and WITH queries.
- [x] Row-value expressions and comparisons, including row-list IN and BETWEEN.
      SQLite validates row cardinality and use in scalar contexts.

Parsing and encoding share precedence rules. Encoding inserts parentheses to
retain tree shape, including right-nested expressions; it does not algebraically
simplify or evaluate expressions. DEFAULT accepts literals, signed numbers or
parenthesized constant expressions and rejects column references and bind parameters in both directions.
CHECK and generated expressions can reference columns. SQLite validates their
context restrictions, including prohibiting subqueries.

## CREATE TABLE and schema files

- [x] CREATE TABLE, TEMP/TEMPORARY, IF NOT EXISTS and optional schema qualification.
- [x] One or more columns with optional type declarations.
- [x] Ordered, optionally named column PRIMARY KEY, NOT NULL, UNIQUE, DEFAULT,
      CHECK, COLLATE, REFERENCES and generated-column constraints.
- [x] Column PRIMARY KEY sort order and AUTOINCREMENT; ON CONFLICT on column
      PRIMARY KEY, NOT NULL and UNIQUE.
- [x] Table PRIMARY KEY, UNIQUE, CHECK and FOREIGN KEY, optionally named.
      Key columns support collation/order, and table keys support ON CONFLICT.
- [x] Foreign-key target columns, ON DELETE/UPDATE, MATCH and deferrability.
      Reference options retain their original order.
- [x] `[GENERATED ALWAYS] AS (expression) [VIRTUAL | STORED]`.
- [x] STRICT and WITHOUT ROWID, retaining order and repeated options.
- [x] Semicolon-separated schema statements, comments and empty statements.
- [x] CREATE TABLE AS SELECT/VALUES/WITH, with schema qualification and TEMP/IF NOT EXISTS.
      Parsing/formatting supports these statements; declarative schema comparison rejects them
      because deriving columns and populating data requires query evaluation.
- [x] CREATE TRIGGER with optional timing, UPDATE OF columns, FOR EACH ROW and WHEN. Use `createTrigger` for one declaration or `schema` for a file. Bodies support queries, INSERT from VALUES or a query, UPDATE assignments and DELETE with an optional WHERE. UPSERT and UPDATE FROM are outside the current body grammar.
- [x] CREATE VIEW, including TEMP, IF NOT EXISTS, schema qualification, optional column names and AS queries. Use `createView` for one declaration.
- [ ] CREATE VIRTUAL TABLE and module-specific arguments.
- [ ] Remaining SQLite grammar edge cases beyond this explicit subset; this is
      not a claim of exhaustive CREATE TABLE compatibility.

Use `createTable` for a single explicit-column declaration, `createTableStatement`
for either explicit columns or AS queries, `schema` for a schema file, and
`sqlExpression` for a standalone expression. `sqlQuery` accepts SELECT cores and standalone VALUES queries. Unsupported trailing input fails
rather than being silently discarded. Parsing does not perform full schema
validation: conflicting constraints, STRICT type restrictions, name resolution
and generated-column dependencies remain SQLite's responsibility.

## Other statement families still to implement

| Family                  | Remaining input syntax                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| Queries                 | Contextual-keyword/legacy-quoting compatibility and further edge cases |
| Schema DDL              | ALTER TABLE, DROP TABLE, DROP INDEX, DROP VIEW and DROP TRIGGER        |
| Data changes            | INSERT/REPLACE, UPSERT, UPDATE, DELETE and RETURNING                   |
| Transactions            | BEGIN, COMMIT/END, ROLLBACK, SAVEPOINT and RELEASE                     |
| Database administration | ATTACH/DETACH, PRAGMA, VACUUM, ANALYZE, REINDEX and EXPLAIN            |

The migration renderer can emit some of these statements without exposing parsers
for them. For example, generating ALTER TABLE ADD COLUMN does **not** mean that
`schema.decode` accepts arbitrary ALTER TABLE input.

## Model and migration coverage

- [x] Convert supported table ASTs to/from serializable core database models.
- [x] Render table creation, explicit table renames and dependency-ordered drops.
- [x] Append eligible columns with ALTER TABLE ADD COLUMN.
- [x] Rebuild tables for supported column, constraint and table-option changes.
      Copy matching names, use defaults for new columns, recompute generated values,
      preserve accessible hidden rowids and retained AUTOINCREMENT high-water marks.
- [x] Report data-loss warnings and reject unsupported copy/dependency plans.
- [x] Apply explicit column-rename decisions through rebuild copy mappings, including type/constraint changes.
- [ ] Infer rename candidates by similarity or define custom data transformations.
- [x] Parse and model standalone indexes, including unique, expression and partial indexes. Recreate desired indexes after rebuilds.
- [x] Model and preserve views during rebuilds.
- [x] Model and preserve triggers during rebuilds.
- [ ] General cross-dialect conversion or arbitrary migration-script parsing.

Core owns comparison and logical planning; this dialect lowers those procedures
and renders SQL. Execution is supplied separately by `@uncutsql/sqlite-driver`,
which currently applies migrations to persistent main SQLite databases. See the
[workspace migration documentation](../../README.md#generate-migration-files-with-a-lock)
for execution, drift-checking and rebuild limitations.

## Verification

Tests combine fixtures from the previous implementation, parse/encode round trips,
source-map assertions, compile-only type checks and native SQLite behavior checks.
SQLite is used **in tests**, not imported by the dialect's production code.
Coverage is evidence for the implemented subset, not an exhaustive conformance score.

## Roadmap

1. Trigger snapshots and migration lowering now cover table and view owners, including partial logical plans.
2. Extend contextual keyword and legacy quoting compatibility. The lexical and query checklists track individual syntax features.

See the [workspace roadmap](../../ROADMAP.md) for the core and executor dependencies.

### Completed work

- [x] Prevent rebuilds from mapping two independent values onto the same integer primary key.
- [x] Accept SQLite single-quoted query aliases and verify the formatted result with SQLite.
- [x] Verify rowid preservation when declared columns shadow all three hidden aliases and update the rebuild guides.
- [x] Reject rebuilds that discard ordinary column values on conversion to generated columns.
- [x] Make index snapshot ordering reproducible across locales and declaration orders.
- [x] Match SQLite tokenization of a trailing bare block-comment opener.
- [x] Parse and format view declarations, with explicit diagnostics at the migration boundary.

```sh
pnpm --filter @uncutsql/sqlite check
pnpm --filter @uncutsql/sqlite build
```

For runnable examples and plugin configuration, see the
[demo walkthrough](../../apps/demo/README.md). API examples and package boundaries
are documented in the [workspace README](../../README.md).

## Query progress

- [x] Standalone VALUES queries, with one or more nonempty rows.
- [x] Reuse expression codecs for each cell, including bind parameters.
- [x] SELECT cores, DISTINCT/ALL, wildcards and explicit/implicit aliases.
- [x] FROM tables and table functions, with schema qualifiers and comma-separated sources.
- [x] FROM subqueries, with aliases and recursively nested derived tables.
- [x] INDEXED BY/NOT INDEXED on named table sources.
- [x] Parenthesized source groups, nested joins and aliases.
- [x] WHERE, GROUP BY/HAVING, WINDOW declarations and ORDER BY.
- [x] LIMIT and OFFSET, including comma syntax with its original expression/binding order.
- [x] UNION, UNION ALL, INTERSECT and EXCEPT, with query-level ORDER BY/LIMIT.
- [x] Comma, INNER, CROSS, LEFT/RIGHT/FULL OUTER and NATURAL joins, with ON/USING.
      SQLite modifier order and compatible combinations are preserved, including LEFT RIGHT JOIN.
- [x] WITH/recursive CTEs, multiple definitions, column lists and MATERIALIZED/NOT MATERIALIZED hints.

`sqlQuery` parses one query with an optional final semicolon and emits a canonical
semicolon. `queryGrammar` supplies the query body used by subquery codecs.
Query ASTs stay separate from `schema`, which represents declarations used for
schema comparison and migrations. SQLite validates row widths and execution
context. Standalone VALUES does not permit ORDER BY or LIMIT.

For example, the query API works without a database driver:

```ts
import { Effect } from "effect";
import { sqlQuery } from "@uncutsql/sqlite";

const ast = Effect.runSync(
  sqlQuery.decode(`
  WITH RECURSIVE numbers(n) AS (
    VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 3
  )
  SELECT n FROM numbers ORDER BY n
`),
);
const sql = Effect.runSync(sqlQuery.encode(ast));
```

The query checklist covers syntax, not full SQLite semantic validation. Name
resolution, recursive-CTE restrictions, result widths and function capabilities
remain SQLite's responsibility. Contextual keywords and legacy quoting still
have compatibility work listed in the lexical checklist.

Query parsing normalizes implicit computed result-column names into explicit
aliases so formatting does not rename columns. Derived-table contexts (FROM
subqueries, CTEs and CREATE TABLE AS) retain SQLite's special column-name handling
for COLLATE and likelihood wrappers around direct column references.
