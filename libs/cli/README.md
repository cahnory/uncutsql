# @uncutsql/cli

The `uncutsql` executable and generic schema/migration workflows. This package has
no dependency on a concrete dialect or database driver. Choose plugins through
`--dialect`, `--driver` or configuration; see the [workspace README](../../README.md).

`pnpm cli --help` runs source in this workspace. Building produces the executable
`dist/index.mjs` and the public API `dist/api.mjs` with declarations. Package exports
and `bin` switch to those built files when packed. `defineConfig` provides typed
configuration for JavaScript/TypeScript config files.

Unit tests use fixture adapters. SQLite end-to-end tests live in `apps/demo`, whose
manifest explicitly declares its selected dialect and driver.

## Review migration decisions

Migration generation stops when columns or tables are removed until their intent
is resolved. Use `decisions before.sql after.sql` to print the review JSON, or:

```sh
uncutsql migration before.sql after.sql --write-decisions choices.json
# Edit each resolution: {"_tag":"Drop"} or {"_tag":"Rename","target":"new_key"}
uncutsql migration before.sql after.sql --decisions choices.json
```

For a saved generation baseline:

```sh
uncutsql generate desired.sql migrations --write-decisions choices.json
# Edit the resolution fields, then generate the concrete SQL for review.
uncutsql generate desired.sql migrations --decisions choices.json
uncutsql apply app.sqlite migrations
```

Preparing choices does not generate or apply a migration. Existing choice files
are never overwritten. Snapshots are rechecked against the current baseline and
target; stale answers require a fresh review. `--decisions` and `--write-decisions`
are mutually exclusive. The file workflow works in CI; terminal prompts are not
implemented yet. The core's structured questions can support another interface.

Validated choices and their snapshots are embedded as one JSON line comment in
the generated SQL. That comment is covered by the existing migration hash and
atomic SQL/lock publication. Apply executes the reviewed script without resolving
intent again. No dialect or driver dependency was added to the CLI.

Public API: `prepareGeneratedDecisions(dialect, ast, directory)` prepares a review
against the locked saved baseline. `generateMigration` and `renderMigration`
accept an optional decision document as their final argument.

## Keep schema paths in project config

In `uncutsql.config.ts`, use the exported helper for editor completion.

```ts
import { defineConfig } from "@uncutsql/cli";

export default defineConfig({
  dialect: "@uncutsql/sqlite",
  driver: "@uncutsql/sqlite-driver",
  schema: "./db/schema",
  migrations: "./db/migrations",
});
```

Put declarations in files such as `db/schema/users.uncut.sql` and
`db/schema/blog/posts.uncut.sql`. Then run `uncutsql check`, `uncutsql format`,
`uncutsql generate`, or `uncutsql apply app.sqlite`. JSON config accepts the same keys.
Configured paths resolve from the config file. Positional paths resolve from the
working directory and override the corresponding settings. Use `--config path`
to select a project from another directory.

Every schema argument, including either side of a diff, accepts a single file or
a directory. Directories include regular `*.uncut.sql` files recursively in sorted
path order. Each file contains complete statements and can omit its final semicolon.
An empty directory produces an error. Use an empty SQL file to express an empty schema.
Use an explicit `-` to read stdin when a project schema is configured.
