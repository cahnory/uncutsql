# @uncutsql/sqlite

Bidirectional SQLite syntax codecs and migration rendering, built on
`@uncutsql/codec` and Effect. This package has **no database-driver dependency**.

## Progress at a glance

The current focus is **table-schema management**, not a general-purpose SQLite
query parser. One input statement family is implemented: `CREATE TABLE` with
explicit column definitions. Expression support is substantial but incomplete.

| Area                   | Status               | Current boundary                                                                                      |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| Lexical syntax         | Supported subset     | Comments, quoted identifiers, literals and operators; contextual keyword fallbacks remain limited     |
| Expressions            | Partial              | Arithmetic, comparisons, calls, IN/BETWEEN, COLLATE and JSON extraction; remaining forms listed below |
| CREATE TABLE           | Supported subset     | Columns, constraints, references, generated columns and table options; no AS SELECT                   |
| Schema files           | Supported subset     | Ordered CREATE TABLE statements, empty statements and optional final semicolon                        |
| Other input statements | Not implemented      | SELECT, other DDL, DML and administrative statements                                                  |
| AST ↔ database model   | Supported for tables | Columns, constraints, options and schema identity; no standalone indexes/views/triggers               |
| Migration output       | Supported subset     | Create, drop, add column and rebuild; this is separate from input parsing                             |
| Database execution     | Separate package     | `@uncutsql/sqlite-driver` owns native SQLite access                                                   |

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
- [ ] Bind parameters: `?`, `?NNN`, `:name`, `@name`, `$name` and extended names.
- [ ] General contextual keyword fallbacks and SQLite's legacy quote reinterpretation.
      Reserved-word identifiers require quotes, except the built-in `temp` schema
      before a dot. TRUE/FALSE retain their contextual expression semantics.

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
- [ ] LIKE / NOT LIKE with ESCAPE.
- [ ] GLOB, REGEXP and MATCH, including their NOT forms.
- [x] CAST expressions, including nested operands and custom/parameterized types.
      Type spelling is preserved; SQLite performs the conversion.
- [ ] CASE expressions, both simple and searched forms.
- [ ] RAISE expressions in trigger contexts.
- [ ] Aggregate syntax: `*`, DISTINCT and argument ORDER BY.
- [ ] FILTER, OVER, named windows and frame specifications.
- [ ] Scalar subqueries, EXISTS and IN targets that are queries, tables or table functions.
- [ ] Row-value expressions and comparisons.

Parsing and encoding share precedence rules. Encoding inserts parentheses to
retain tree shape, including right-nested expressions; it does not algebraically
simplify or evaluate expressions. DEFAULT accepts literals, signed numbers or
parenthesized constant expressions and rejects column references in both directions.
CHECK and generated expressions can reference columns.

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
- [ ] CREATE TABLE AS SELECT.
- [ ] CREATE VIRTUAL TABLE and module-specific arguments.
- [ ] Remaining SQLite grammar edge cases beyond this explicit subset; this is
      not a claim of exhaustive CREATE TABLE compatibility.

Use `createTable` for a single declaration, `schema` for a schema file, and
`sqlExpression` for a standalone expression. Unsupported trailing input fails
rather than being silently discarded. Parsing does not perform full schema
validation: conflicting constraints, STRICT type restrictions, name resolution
and generated-column dependencies remain SQLite's responsibility.

## Other statement families still to implement

| Family                  | Remaining input syntax                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Queries                 | SELECT, VALUES, WITH/recursive CTEs, joins, compounds, grouping, ordering and limits |
| Schema DDL              | ALTER TABLE, DROP TABLE, CREATE/DROP INDEX, VIEW and TRIGGER                         |
| Data changes            | INSERT/REPLACE, UPSERT, UPDATE, DELETE and RETURNING                                 |
| Transactions            | BEGIN, COMMIT/END, ROLLBACK, SAVEPOINT and RELEASE                                   |
| Database administration | ATTACH/DETACH, PRAGMA, VACUUM, ANALYZE, REINDEX and EXPLAIN                          |

The migration renderer can emit some of these statements without exposing parsers
for them. For example, generating ALTER TABLE ADD COLUMN does **not** mean that
`schema.decode` accepts arbitrary ALTER TABLE input.

## Model and migration coverage

- [x] Convert supported table ASTs to/from serializable core database models.
- [x] Render table creation and dependency-ordered drops.
- [x] Append eligible columns with ALTER TABLE ADD COLUMN.
- [x] Rebuild tables for supported column, constraint and table-option changes.
      Copy matching names, use defaults for new columns, recompute generated values,
      preserve accessible hidden rowids and retained AUTOINCREMENT high-water marks.
- [x] Report data-loss warnings and reject unsupported copy/dependency plans.
- [ ] Infer renames or define custom data transformations.
- [ ] Model and preserve standalone indexes, views and triggers during rebuilds.
- [ ] General cross-dialect conversion or arbitrary migration-script parsing.

Core owns comparison and logical planning; this dialect lowers those procedures
and renders SQL. Execution is supplied separately by `@uncutsql/sqlite-driver`,
which currently applies migrations to persistent main SQLite databases. See the
[workspace migration documentation](../../README.md#generate-migration-files-with-a-lock)
for execution, drift-checking and rebuild limitations.

## Verification and next milestones

Tests combine fixtures from the previous implementation, parse/encode round trips,
source-map assertions, compile-only type checks and native SQLite behavior checks.
SQLite is used **in tests**, not imported by the dialect's production code.
Coverage is evidence for the implemented subset, not an exhaustive conformance score.

Suggested order for further work:

1. Finish schema-useful expressions: CASE and pattern matching with ESCAPE.
2. Add standalone indexes and their model/migration support.
3. Add views/triggers and safe preservation during table rebuilds.
4. Expand query grammar and the expression forms that depend on it.

```sh
pnpm --filter @uncutsql/sqlite check
pnpm --filter @uncutsql/sqlite build
```

For runnable examples and plugin configuration, see the
[demo walkthrough](../../apps/demo/README.md). API examples and package boundaries
are documented in the [workspace README](../../README.md).
