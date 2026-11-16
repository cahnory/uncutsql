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

| Combinator | Decode | Encode |
| --- | --- | --- |
| `literal` | Match exact text | Check the literal value and print it |
| `tuple` / `struct` | Parse members sequentially | Print the same members in order |
| `transform` | Apply the forward mapping | Apply the supplied inverse |
| `transformEffect` | Effectful forward mapping | Effectful inverse mapping |
| `taggedUnion` | Try members until one matches | Select the member using `_tag` |
| `alternatives` | Try equivalent spellings | Use the first, canonical spelling |
| `optional` | Recover an uncommitted mismatch | Omit `undefined` |
| `repeat` | Parse items, optionally with syntax separators | Print items and separators |
| `prefixed` / `followedBy` | Parse fixed syntax and commit the remainder | Print fixed syntax around the value |
| `located` | Wrap child spans in a named source node | Forward the semantic value |
| `observe` | Add a span and a success debug event | Add a span and a success debug event |

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
An AST alone does not retain comments or formatting.

## Next steps

1. Extend literals and expressions with explicit precedence and round-trip tests.
2. Extend `CREATE TABLE` using the existing fixture corpus: type names, table
   constraints, foreign keys, generated columns and options.
3. Add statement lists and further DDL variants through tagged unions.
4. Restore the pipeline `SQL → AST → virtual database → diff → migration AST → SQL`.
   Return schema warnings as structured diagnostics; logging can report them.
5. Add application services for configuration, filesystem access and database
   inspection. Keep ordinary AST transformations pure.

Effect Schema can validate incoming ASTs or expose a whole-document transformation
later. It does not replace this grammar's cursor, backtracking, precedence and
trivia responsibilities. Effect's standard logger and tracing mechanisms already
provide the observability boundary; no separate logging service is needed.

References: [Effect transformations](https://effect.website/docs/v4/schema/transformations),
[Effect logging](https://effect.website/docs/v4/observability/logging),
[SQLite identifier quoting](https://www.sqlite.org/lang_keywords.html),
[SQLite comments](https://www.sqlite.org/lang_comment.html).
