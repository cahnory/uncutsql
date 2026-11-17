# @uncutsql/sqlite-driver

Optional Node SQLite migration executor. Exports `executor`, `applyMigrations`
and `SqliteExecutionError`; implements the core `MigrationExecutor` contract.

This package owns `node:sqlite` access. It depends on `@uncutsql/sqlite` for schema
inspection; the dialect never imports this driver. Select it with the CLI's
`--driver @uncutsql/sqlite-driver` flag or `driver` configuration setting.

See the [workspace README](../../README.md) for execution constraints and history
semantics. Run `pnpm --filter @uncutsql/sqlite-driver check` to verify the driver.
