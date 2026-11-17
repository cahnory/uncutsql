# Demo

This is a consumer of uncutsql. Its `uncutsql.config.json` selects
`@uncutsql/sqlite` and `@uncutsql/sqlite-driver` by package name. The CLI discovers
that file from the demo's working directory, just as in a user's project.

Run these commands from the **repository root** after `pnpm install`. No build
is needed; workspace packages export TypeScript source.

```sh
# Effect composition, AST output and JSON logging
pnpm demo

# CLI help, syntax validation and canonical SQL
pnpm demo:cli --help
pnpm demo:cli check examples/schema.sql
pnpm demo:cli format examples/schema.sql

# Compare schemas and preview a migration without writing or executing it
pnpm demo:cli diff examples/schema.sql examples/schema-next.sql
pnpm demo:cli migration examples/schema.sql examples/schema-next.sql
```

`pnpm demo:cli` runs inside `apps/demo`. Input paths and output paths are relative
to that directory. `pnpm cli` remains the generic CLI running from your current
working directory; it does not implicitly choose the demo's config.

## Generate and apply migrations

Run the following in order. Generated files and the SQLite database live in the
ignored `apps/demo/.local/` directory. The first generation creates the directory.

```sh
# Create the initial migration and its schema lock, then apply it
pnpm demo:cli generate examples/schema.sql .local/migrations
pnpm demo:cli apply .local/app.sqlite .local/migrations

# Add a nullable email column
pnpm demo:cli generate examples/schema-expand.sql .local/migrations
pnpm demo:cli apply .local/app.sqlite .local/migrations

# Add uniqueness and a CHECK constraint, exercising the table-rebuild planner
pnpm demo:cli generate examples/schema-next.sql .local/migrations
pnpm demo:cli apply .local/app.sqlite .local/migrations

# Repeating the final operations makes no changes
pnpm demo:cli generate examples/schema-next.sql .local/migrations
pnpm demo:cli apply .local/app.sqlite .local/migrations
```

Inspect `.local/migrations/*.sql` and `.local/migrations/uncutsql.lock.json` to
see generated SQL and the recorded baseline. The database tracks applied history
separately. To repeat from an empty database, choose a fresh directory and database
path (for example `.local/second/migrations` and `.local/second/app.sqlite`) for
all commands in the sequence.

To work directly from the demo directory instead:

```sh
cd apps/demo
pnpm cli check examples/schema.sql
pnpm cli format examples/schema-next.sql
```

The demo's tests cover CLI/SQLite integration. Dialect-independent CLI tests live
in `libs/cli`; native execution tests live in `libs/sqlite-driver`.
