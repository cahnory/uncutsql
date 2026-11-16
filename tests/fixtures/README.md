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
