# UncutSQL

This package provides a starter configuration for managing SQLite migrations with
UncutSQL. The configuration selects a schema file named `schema.uncut.sql` and a
`migrations/` directory. To use a multipart schema, change `schema` to a directory
of `*.uncut.sql` files.

Install the preset and copy it into a new project.

```sh
npm install --save-dev uncutsql
node -e "const fs = require('node:fs'); fs.copyFileSync(require.resolve('uncutsql/sqlite-config.json'), 'uncutsql.config.json', fs.constants.COPYFILE_EXCL)"
```

## Scoped packages

| Package | Purpose |
| --- | --- |
| `@uncutsql/cli` | Check schemas, generate migration files, and apply migrations. |
| `@uncutsql/sqlite` | Parse SQLite schemas and generate SQLite migration SQL. |
| `@uncutsql/sqlite-driver` | Inspect SQLite databases and execute migrations. |

The CLI, dialect, and driver are installed separately.
