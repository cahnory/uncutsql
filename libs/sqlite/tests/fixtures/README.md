# Fixture provenance

`create-table/valid` and `create-table/invalid` are unchanged copies selected from
`../uncutsql/libs/sqlite-dialect/src/rules/__fixtures__/create-table-statement`.
Only valid examples within the grammar's supported subset are included.
The tests need no access to the previous project.

Valid fixtures are parsed, canonically encoded, parsed again, and executed against
SQLite to compare their resulting column definitions with the original SQL.
Default expressions are compared as ASTs because SQLite stores their SQL spelling.
The selection includes literal/expression defaults, column CHECKs, named and table
constraints, and column/composite foreign keys with actions and deferrability.
SQLite index and foreign-key metadata are compared as well.
Invalid fixtures must fail through the typed parse-error channel.

The selection also includes parameterized/multiword types, AUTOINCREMENT,
collations, generated columns and STRICT/WITHOUT ROWID options. Tests use
`table_xinfo` to include generated columns and compare `table_list` flags.

`previous/` contains unchanged copies of all valid, invalid and edge SQL fixtures
for `column-constraint`, `type-name` and `table-options`, and all CREATE TABLE edge
fixtures, from the same previous `rules/__fixtures__` directory. Every copied file
runs, including `.skip.sql`. The explicit overrides in
`tests/previous-edge-cases.test.ts` accept repeated STRICT options (SQLite accepts
them), and reject unquoted reserved words used as collation/type/table names (the
new grammar requires quoting). Syntax-only tests intentionally accept constraints
that SQLite later rejects during schema validation, such as conflicting primary
keys. Separate behavioral tests exercise executable schemas against SQLite.

`previous/table-reference` also imports the entire earlier table-reference corpus.
The doubled-bracket fixture remains unchanged but is expected to fail: SQLite
ends bracket quoting at the first closing bracket. Reserved-word edge fixtures
require quotes. The CREATE TABLE selection includes `05_schema_qualified.sql`;
additional native tests check main, temp and attached schema placement.

`rebuild/schema.sql` and `rebuild/schema-next.sql` snapshot the demo schemas for
the table-rebuild regression test. Keeping them local makes this regression
independent of changes to the demo layout or examples.

`expression/07_collate.sql` is an unchanged copy of the previous implementation's
`rules/__fixtures__/expression/valid/07_collate.sql`, exercised by the expression
collation tests.

`expression/02_json_arrow.sql` is an unchanged copy of the previous implementation's
`rules/__fixtures__/expression/edge/02_json_arrow.sql`.

`expression/06_case.sql` and `expression/03_bad_case.sql` are unchanged copies
of the earlier expression valid/invalid CASE fixtures.

`previous/raise-function` contains unchanged copies of all previous RAISE fixtures.

`previous/ordering-term` and `previous/filter-clause` contain the complete earlier
fixture groups, including valid, invalid and edge cases.

The `frame-spec` and `over-clause` groups are copied unchanged from the previous
implementation and exercised by `window-expression.test.ts`.

`select-values/valid.sql` is copied unchanged from the previous
`select-core/valid/06_select_values.sql` and exercised by `query.test.ts`.

The full `select-core` group is copied unchanged from the previous rules and
exercised by `select-query.test.ts`, including its VALUES fixture.

`select-statement` copies all previous fixtures unchanged, including WITH and
recursive cases. They run in `compound-query.test.ts`.

The two subquery fixtures in `table-or-subquery/valid` are copied unchanged from
the previous implementation and run in `derived-table.test.ts`.

The complete `join-operator`, `join-constraint`, `join-clause` and
`table-or-subquery` groups are now copied unchanged and run in `join-query.test.ts`.

`previous/create-table-as/29_create_as_select.sql` is copied unchanged from the
previous CREATE TABLE valid fixtures and tested in `create-table-as.test.ts`.
