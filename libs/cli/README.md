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
# Review each pending resolution.
uncutsql migration before.sql after.sql --decisions choices.json
```

Each generated resolution starts as an object:

```json
{ "action": "pending" }
```

Choose `drop_if_empty` to require an empty table or an all-NULL column, or `drop`
to allow removal with data. For a table or column rename, choose `rename` and set `target`
to a name from `candidates`. After selecting a table rename, run
`--merge-decisions` to reveal any column questions for the selected pair. Pending
actions stop migration generation until reviewed. The schema declares the action
choices together so editors can suggest `rename` before its target is filled in.

For a saved generation baseline:

```sh
uncutsql generate desired.sql migrations --write-decisions choices.json
# Edit the resolution fields, then generate the concrete SQL for review.
uncutsql generate desired.sql migrations --decisions choices.json
uncutsql apply app.sqlite migrations
```

Run `uncutsql generate desired.sql migrations --interactive` to answer removal and
rename questions in the terminal. A table rename can lead to further questions
about its columns. Enter the number of your choice, or `q` to cancel before
publishing the migration. This mode reads answers from stdin, so use a schema
file or directory. It skips configured and default decision files.

Both `generate` and `migration` accept one decision-file option per invocation.

| Flag                         | Behavior                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--write-decisions [file]`   | Create a fresh review. If the file already exists, show the merge and rewrite options.                                                                                                       |
| `--merge-decisions [file]`   | Refresh the review, keeping answers for matching table and column removals. A rename whose target disappeared becomes pending. Obsolete questions disappear and new questions start pending. |
| `--rewrite-decisions [file]` | Replace the review with fresh questions, all pending.                                                                                                                                        |
| `--decisions <file>`         | Read the reviewed answers and generate SQL.                                                                                                                                                  |

All three preparation flags can create the file when it is missing. They leave
migration files and the lock untouched. Merge validates the previous review
before replacing it. Generation checks the refreshed snapshots against the current schemas.

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
  decisions: "./db/decisions.json",
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

## Diff the edited schema against its lock

`uncutsql diff` compares the configured schema with the saved database model in
`<migrations>/uncutsql.lock.json`. Edit the schema file or directory directly, review
the diff, then run `uncutsql generate` to publish the migration and update the lock.
A missing baseline means an empty schema; existing migration history and hashes
are checked before comparison. Diff never creates migration files or directories.

```sh
uncutsql                              # read-only diff using discovered config
uncutsql --config ./db/settings.json   # read-only diff using this config
uncutsql diff --schema ./db/schema --migrations ./db/migrations --dialect @uncutsql/sqlite
uncutsql diff ./db/schema              # override the configured schema
uncutsql diff before.sql after.sql     # explicit two-schema comparison
```

Discovery checks the working directory: `package.json`'s `uncutsql` property first,
then `.uncutsqlrc.json`, then `uncutsql.config` with extensions `.json`, `.js`,
`.cjs`, `.mjs`, `.ts`, `.cts`, `.mts`, in that order. It does not search parent
directories or guess schema paths. With no configured or explicit schema, a bare
invocation returns a usage error. Migration output defaults to `./migrations`.

`--schema` and `--migrations` override config and resolve from the working directory.
Positional paths take precedence over those flags. `--dialect` and `--driver` also
override config. Database application always requires `apply` and an explicit target.

## Default decision file

`migration` and `generate` automatically read `decisions` from config. The default
is `uncutsql.decisions.json` beside the config, or in the working directory when
no config is found. An absent default is ignored; an absent explicitly configured
file or `--decisions` path is an error. Malformed and stale files fail validation.
Other commands do not read this file.

```sh
uncutsql generate --write-decisions  # create the configured/default review file
# Edit its resolution fields.
uncutsql generate                    # load the answers automatically
```

Each preparation flag accepts an optional output path. Explicit paths resolve
from the working directory. Configured paths resolve from the config directory.

## JSON schemas

JSON config and decision files support an optional `$schema` property for editor
completion and validation. The CLI package includes and exports both schemas:

- `@uncutsql/cli/schemas/config.schema.json`
- `@uncutsql/cli/schemas/decisions.schema.json`

For example, in a project's `uncutsql.config.json`:

```json
{
  "$schema": "./node_modules/@uncutsql/cli/schemas/config.schema.json",
  "dialect": "@uncutsql/sqlite",
  "schema": "./db/schema",
  "migrations": "./db/migrations"
}
```

Generated decisions include `$schema` automatically. The CLI looks for the schema
in an ancestor’s `node_modules`, falling back to the working directory’s
`node_modules`, and writes a path relative to the decision file. The `decisions`
command uses the working directory for its JSON output. Schema paths in config
resolve relative to the JSON file; adjust the path for files in subdirectories. In this repository, the schemas live in
[`schemas`](./schemas).

The decisions schema covers the snapshots, pending `{ "action": "pending" }` resolutions, and
`drop_if_empty`, `drop`, and `rename` answers. The CLI additionally checks snapshot freshness, decision
identities, rename candidates, and duplicate targets when consuming answers.
The generated `uncutsql.lock.json` is managed by the CLI and has no editor schema.

## Roadmap

- [x] Bound concurrent migration-file reads during apply.
- [x] Reconcile the decision-review documentation with verified behavior.
- [ ] Verify diff and lock-backed generation for schemas containing views, then exercise apply and drift checks with the SQLite driver. Repeat for triggers when supported.

See the [workspace roadmap](../../ROADMAP.md) for cross-project sequencing.
