# Fixture provenance

`create-table/valid` and `create-table/invalid` are unchanged copies selected from
`../uncutsql/libs/sqlite-dialect/src/rules/__fixtures__/create-table-statement`.
Only valid examples within the initial grammar's supported subset are included.
The tests need no access to the previous project.

Valid fixtures are parsed, canonically encoded, parsed again, and executed against
SQLite to compare their resulting column definitions with the original SQL.
Invalid fixtures must fail through the typed parse-error channel.
