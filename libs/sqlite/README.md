# @uncutsql/sqlite

SQLite parsing and serialization built on @uncutsql/codec.

See the [workspace README](../../README.md) for API examples and supported syntax.

```sh
pnpm --filter @uncutsql/sqlite check
pnpm --filter @uncutsql/sqlite build
```

The optional `@uncutsql/sqlite/node` entry point exports an executor and
applyMigrations for persistent main SQLite databases. It receives the complete
ordered SQL history plus a consumer-provided schema verifier. It owns per-file
transactions and atomic applied-history recording, and reserves
`__uncutsql_migrations`. The default package entry point does not load Node's
database driver. See the workspace README for the CLI application workflow and
current execution limits.
