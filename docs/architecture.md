# Architecture decisions

## What carries forward

The earlier `libs/codec/src2` separates generic codecs, syntax nodes and
whole-string entry points. This implementation retains that separation. The
`src`/`src2` operator implementations mainly compose decoding; the new operators
compose both directions. In particular, a transform requires an inverse and a
tagged union selects its encoder by semantic tag.

The `new-codecs/_internal/rule-codec.ts` adapter in the previous implementation
bridges the separate parser and serializer, copies remaining input, strips runtime
metadata, and uses broad casts. It is useful migration scaffolding, but is not a
dependency of this implementation. The old grammar and fixtures remain references.

## The codec boundary

```ts
interface Codec<A, E = never, R = never> {
  readonly decode: (cursor: Cursor) => Effect<Read<A>, ParseError | E, R>;
  readonly encode: (value: A) => Effect<string, EncodeError | E, R>;
}
```

`E` describes additional failures and `R` describes service requirements. This
first API conservatively unions requirements/errors across both directions;
a service used only by decoding is also present on the codec's encode type.
Direction-specific parameters can be added if actual usage warrants them.
When implementing a primitive with `make`, explicit type parameters are useful
to establish that primitive's contract. Composition preserves the inferred
value, additional errors and requirements; compile-only tests guard this.

`make` suspends callbacks. Constructing a codec or calling its methods does not
execute user code. There are no internal `runSync`/`runPromise` calls. Use
`transformEffect` for conversions that need services or can fail; ordinary
`transform` callbacks must be total over their declared domain. Unexpected
exceptions remain Effect defects.

Grammar decoding returns `{ value, next, nodes }`. `document` supplies the initial
cursor, handles optional outer trivia, and rejects leftover input. Its ordinary
`decode` returns only the semantic value. `decodeWithSourceMap` retains locations.
Document APIs are typed boundaries; `encode` does not validate arbitrary unknown
JSON. A future Effect Schema adapter can perform that validation.

## Composition contracts

| Combinator                | Decode                                         | Encode                               |
| ------------------------- | ---------------------------------------------- | ------------------------------------ |
| `literal`                 | Match exact text                               | Check the literal value and print it |
| `tuple` / `struct`        | Parse members sequentially                     | Print the same members in order      |
| `transform`               | Apply the forward mapping                      | Apply the supplied inverse           |
| `transformEffect`         | Effectful forward mapping                      | Effectful inverse mapping            |
| `taggedUnion`             | Try members until one matches                  | Select the member using `_tag`       |
| `alternatives`            | Try equivalent spellings                       | Use the first, canonical spelling    |
| `optional`                | Recover an uncommitted mismatch                | Omit `undefined`                     |
| `repeat`                  | Parse items, optionally with syntax separators | Print items and separators           |
| `prefixed` / `followedBy` | Parse fixed syntax and commit the remainder    | Print fixed syntax around the value  |
| `located`                 | Wrap child spans in a named source node        | Forward the semantic value           |
| `observe`                 | Add a span and a success debug event           | Add a span and a success debug event |

`alternatives` is for branches with the same semantic domain, such as `TEMP` and
`TEMPORARY`, or identifier quote styles. It does not try encoders until one works.
Use `taggedUnion` for different semantic variants.

The string join argument to `tuple`/`struct`, and `repeat`'s `join` option, control
formatting only. The child grammars must accept that formatting. SQLite lexemes
consume leading trivia, so spaces between keywords are accepted in both
directions. Actual separators such as commas are codecs supplied to `repeat`'s
`separator` option; their syntax is defined once for both directions.

Fixed syntax has `void` semantics. To distinguish an optional keyword's presence,
map it to a value (the SQLite `flag` helper maps it to `true`) before applying
`optional`. An optional `Codec<void>` alone cannot retain presence information.

## Backtracking and effects

Cursors are immutable `{ source, offset }` values. Alternatives always receive
the original cursor. Source nodes are returned from successful branches, so a
failed branch cannot leak source metadata. Effects can be rerun or executed
concurrently without shared parser state. Primitive character scanning stays
synchronous inside an Effect callback.

An uncommitted `ParseError` means the caller may try another branch. `commit`
marks parse errors as final. `prefixed` commits the body only after the prefix
matches; a consumed comma similarly commits to another list item. A missing
closing quote commits once its opening quote has been read. Alternatives retain
the furthest error and merge expectations at equal offsets. Optional/repeated
uncommitted failures are treated as normal absence/list termination.

Recovery checks the error class and commitment flag. Unrelated service failures,
defects and interruption are not converted into grammar mismatches. Repetition
rejects an item that succeeds without advancing, and rejects empty encoded items.

**Backtracking only rolls back parser results, not external effects.** Keep
external mutations out of speculative grammar branches. Debug events from a
successful nested rule can belong to a larger branch that is later rejected.
Prefer observing whole documents unless debugging individual grammar decisions.

## AST and source representation

The semantic AST contains only the values needed to re-encode the supported SQL.
Constraints are an ordered array, rather than being grouped by kind during
parsing. A later virtual-database transformation can group them for analysis.

The source map is a separate nested tree. Offsets are zero-based UTF-16 code units
with an exclusive end; diagnostic line/column values are one-based, also counting
UTF-16 code units. CRLF is treated as one newline. Nodes are emitted only for
named rules, not every punctuation or trivia token. There are no cyclic parent
references. Original source is retained once by `decodeWithSourceMap`.

Canonical output is intentional. Exact source-preserving editing would require
a richer concrete syntax model and an explicit policy for modified subtrees.
An AST generally does not retain comments or formatting. Type declarations are
an exception: their retained spelling carries SQLite semantics (see below).

## SQLite expressions

The SQLite files follow the previous project's separation into lexical helpers,
operators and grammar codecs. Literals, column constraints and expression variants
have individual modules; the public entry points from the initial foundation are
retained as re-exports.

The recursive expression grammar uses precedence climbing rather than a separate
parser for every precedence level. `expression/operators.ts` defines the precedence
and canonical spelling for both directions. A binary operator parses its right
operand at one level above its own precedence, making operators left-associative.
Printing uses the same rule to retain right-nested trees. `NOT` is below comparisons
but above `AND`, while symbolic unary operators bind above concatenation.
Postfix null tests bind below equality but above unary `NOT`; `NOT NULL` normalizes
to `NOTNULL` while retaining this distinct precedence.

Parentheses have source-map nodes but do not add semantic AST variants. The printer
adds grouping where required; it never algebraically reassociates expressions.
Unary printing separates nested signs so negation cannot become a line comment.
No expression is evaluated by the codec.

Numeric values retain unsigned SQL spelling in a string. Converting to a JS number
would lose integers above 2^53 and distinctions such as INTEGER `1` versus REAL
`1.0`. Hexadecimal literals are limited to SQLite's 64-bit range of significant
digits. Blob values are hex byte pairs. Keyword literals retain TRUE/FALSE spellings
instead of converting them to 1/0, because SQLite may resolve those words to columns
and gives them special behavior on the right side of `IS`.

The DEFAULT codec follows the restricted SQLite production: a literal, a signed
numeric literal, or a parenthesized constant expression. It does not accept an
unparenthesized `DEFAULT 1 + 2`. Column references are rejected when decoding or
encoding defaults. The CHECK codec requires parentheses but permits column references.
Parameters, subqueries and additional operator families are not yet
part of the expression grammar.

Tests compare original and encoded SQL against SQLite, including INTEGER/REAL
results, every supported binary precedence pair, unary/binary interactions, default
evaluation and CHECK enforcement. The expanded fixture set includes the earlier
implementation's literal defaults, expression defaults and column checks.

## Table constraints and references

`CreateTable` now has a required `tableConstraints` array alongside `columns`.
This is a small intentional change to constructed ASTs: callers without table
constraints should supply `[]`. Both arrays preserve source order. The table-body
codec requires a first column and rejects columns after table constraints.

Column and table constraint codecs share `namedConstraint`, which adds an optional
`name` field without changing the semantic tag. Table PRIMARY KEY and UNIQUE
codecs share indexed-column syntax (identifier, optional collation, optional order)
and conflict-clause syntax. They do not accept arbitrary expressions as key columns.
CHECK uses the same expression codec at both levels.

Column REFERENCES and table FOREIGN KEY share a `ForeignKeyClause` value: target
table, optional target columns, ordered MATCH/ON options and optional deferrability.
An omitted target column list is distinct from an empty list, which is rejected.
ON options are an array rather than a dictionary, so repeated clauses and source
ordering are not silently discarded. SQLite remains responsible for schema-aware
checks and for its interpretation of MATCH clauses and constraint conflicts.

Tests compare SQLite's column, index and foreign-key metadata before and after
encoding. Behavioral tests cover CHECK/UNIQUE enforcement, composite cascading
updates/deletes, SET DEFAULT and RESTRICT actions, and immediate versus deferred
foreign-key enforcement within transactions.

## Type declarations and remaining column features

The previous type-name rule used a list of recognized names and numeric parameters.
Ordinary SQLite tables also accept custom names. `typeName` remains a string, but
is now validated by a grammar for identifier words and up to two signed numeric
parameters. Encoding validates the complete declaration before emitting it, so a
constructed value cannot append constraints or statements.

Retaining the raw declaration is deliberate: quoted multiword names can produce
a different declared type than their unquoted equivalent, and comments inside a
type declaration can affect affinity. For example, `CUSTOM /* INT */ TYPE` has
integer affinity. Normalizing the words or dropping that comment changes behavior.
Numeric dimensions reject digit separators, which SQLite accepts in general
expressions but rejects in this production.

Column PRIMARY KEY retains optional sort order, conflict action and AUTOINCREMENT.
NOT NULL and UNIQUE share a conflict-clause helper. COLLATE and generated columns
have individual codecs. Generated columns retain their expression and optional
VIRTUAL/STORED mode; omitted mode stays absent in the AST. Encoding uses the full
GENERATED ALWAYS AS prefix.

Unlike the earlier column-definition transformation's last-value selection,
constraints remain ordered, including repeated defaults and collations. Table
options also remain an ordered array rather than the earlier pair of booleans:
SQLite accepts repeated STRICT and WITHOUT ROWID options. Absent new optional
fields are omitted so existing ASTs continue to round-trip unchanged.

The regression suite imports every column-constraint, type-name and table-options
fixture from the previous implementation, plus CREATE TABLE edge fixtures. Even
files named `.skip.sql` run; classification overrides are explicit in the tests.
Native SQLite tests verify generated values, rowid alias behavior, AUTOINCREMENT,
conflict actions, collation, STRICT coercion and WITHOUT ROWID metadata. Schema
checks such as conflicting primary keys or invalid STRICT types remain SQLite's
responsibility rather than becoming syntax errors in the codec.

## Schema-qualified table declarations

`table-reference.ts` composes an identifier with an optional dot and second
identifier, following the old table-reference rule. `CreateTable` keeps `name`
and adds optional `schema`; existing unqualified ASTs retain their shape. Dots
inside quoted identifiers are never split. Each identifier retains a separate
source span, and the dot commits parsing to a following table name.

The built-in `temp` schema is accepted unquoted before a dot, preserving its case.
Other reserved-word identifiers still require quoting. Qualification is specific
to table declarations: REFERENCES targets remain unqualified, as SQLite requires.
Schema existence and TEMP/schema conflicts are left to SQLite validation.

All previous table-reference fixtures run, with explicit corrections for unquoted
reserved words and the old doubled-bracket example (SQLite does not support that
escape). Native tests compare placement in main, temp and attached databases,
including quoted names containing dots and tables with namesakes in other schemas.

## Next steps

1. Extend expressions with the remaining SQLite operator families.
2. Add statement lists and further DDL variants through tagged unions.
3. Restore the pipeline `SQL → AST → virtual database → diff → migration AST → SQL`.
   Return schema warnings as structured diagnostics; logging can report them.
4. Add application services for configuration, filesystem access and database
   inspection. Keep ordinary AST transformations pure.

Effect Schema can validate incoming ASTs or expose a whole-document transformation
later. It does not replace this grammar's cursor, backtracking, precedence and
trivia responsibilities. Effect's standard logger and tracing mechanisms already
provide the observability boundary; no separate logging service is needed.

References: [Effect transformations](https://effect.website/docs/v4/schema/transformations),
[Effect logging](https://effect.website/docs/v4/observability/logging),
[SQLite identifier quoting](https://www.sqlite.org/lang_keywords.html),
[SQLite comments](https://www.sqlite.org/lang_comment.html),
[SQLite expression precedence](https://www.sqlite.org/lang_expr.html),
[SQLite DEFAULT and CHECK clauses](https://www.sqlite.org/lang_createtable.html).

## Workspace boundaries

The workspace separates reusable libraries in `libs/*`
from executable consumers in `apps/*`. `@uncutsql/codec` has no SQLite dependency;
`@uncutsql/sqlite` imports the codec through its package export. The demo imports
both packages rather than reaching into sibling source trees. All packages retain
Effect 4.1.4 and the existing TypeScript strictness settings.

Tests and compile-only inference checks belong to their library. The root runs
recursive package checks and shares the compact Node test reporter, formatting,
lint and TypeScript configuration. Library builds use tsdown with external
dependencies, source exports for workspace development, and ESM/CommonJS exports
for distribution. No release workflow is enabled while the packages are private.

## Function calls

Ordinary calls are primary expressions with a name and ordered expression arguments.
The opening parenthesis commits parsing; a bare name can still fall back to a
column reference. Calls share the existing expression grammar for arguments,
including nested calls and source spans. Names encode as quoted identifiers.
DEFAULT validation recursively checks arguments for column references and wraps
calls in parentheses. Function lookup, arity and context restrictions remain
SQLite's responsibility. Aggregate modifiers, FILTER and OVER are not implemented.
