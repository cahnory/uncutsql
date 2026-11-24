# Workspace roadmap

View migrations now run through the CLI and SQLite driver. Snapshots, diffs and generated SQL include views, and the demo exercises a dependent view across a rebuild and a column rename.

The trigger migration milestone is complete. The next milestone is VS Code support for schema files.

| Step                                          | Handoff                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. Represent and parse triggers (done)        | Core models and compares triggers. SQLite parses and formats declarations with SELECT, INSERT, UPDATE and DELETE actions. |
| 2. Generate trigger migrations (done)         | SQLite maps declarations to the core model and orders trigger removal and recreation around table and view changes.       |
| 3. Apply and verify trigger migrations (done) | The driver inspects live triggers. The CLI and demo exercise generation, rebuild preservation and drift detection.        |

SQLite snapshots now round-trip triggers on tables and views through JSON. Generated migrations now suspend triggers before rebuilding tables or replacing their views. The demo verifies that deleting through a view fires its trigger after a rebuild and that CLI apply detects a changed trigger body.

SQLite contextual keyword and legacy quoting work can proceed independently of these handoffs.

## VS Code support after trigger migrations

Ship a first VS Code extension for SQLite schema files managed by UncutSQL.

- Report syntax errors at the location returned by the parser.
- Show schema declarations and their columns in the document Outline.
- Support Go to Definition (F12) on the target table and column of a foreign key across schema files.

For the first release, use VS Code providers directly and keep symbol extraction and lookup in an editor-independent language service. Follow the CLI's configured schema scope and use the current editor text for open files.

The long-term plan is to expose that service through an UncutSQL language server implementing the Language Server Protocol (LSP). The VS Code extension will become an LSP client, and other editors will be able to use the same server.

Verify navigation with the [multipart demo](apps/demo/examples/multipart/schema/blog/posts.uncut.sql). From `REFERENCES users(id)`, F12 on `users` should reach the table declaration and F12 on `id` should reach its column. Check both with the target file closed and after an unsaved edit moves the declaration.

Use feedback from this release to decide whether to index references next. Revisit project-wide rename and completion inside views after assessing the name resolution they require.

## Project roadmaps

Each project maintains its priorities and completion status in its README. Update this file when a workspace milestone, its order, or a dependency between projects changes.

- [Codec](libs/codec/README.md#roadmap)
- [Core](libs/core/README.md#roadmap)
- [SQLite dialect](libs/sqlite/README.md#roadmap)
- [SQLite driver](libs/sqlite-driver/README.md#roadmap)
- [CLI](libs/cli/README.md#roadmap)
- [Demo](apps/demo/README.md#roadmap)
