# Workspace roadmap

View migrations now run through the CLI and SQLite driver. Snapshots, diffs and generated SQL include views, and the demo exercises a dependent view across a rebuild and a column rename.

The trigger migration and initial VS Code milestones are complete.

| Step                                          | Handoff                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. Represent and parse triggers (done)        | Core models and compares triggers. SQLite parses and formats declarations with SELECT, INSERT, UPDATE and DELETE actions. |
| 2. Generate trigger migrations (done)         | SQLite maps declarations to the core model and orders trigger removal and recreation around table and view changes.       |
| 3. Apply and verify trigger migrations (done) | The driver inspects live triggers. The CLI and demo exercise generation, rebuild preservation and drift detection.        |

SQLite snapshots now round-trip triggers on tables and views through JSON. Generated migrations now suspend triggers before rebuilding tables or replacing their views. The demo verifies that deleting through a view fires its trigger after a rebuild and that CLI apply detects a changed trigger body.

SQLite now accepts legacy single quotes around relation names, declared columns and foreign key targets. The driver verifies these names when applying and resuming a migration, and the editor resolves quoted foreign key targets across documents.

Explicit result and table aliases now accept SQLite contextual keywords. Tests compare every dialect keyword after `AS` with native SQLite. Implicit aliases now accept unambiguous contextual keywords while preserving join, index-hint and expression boundaries.

Next, distinguish `WINDOW`, `FILTER` and `OVER` used as implicit aliases from the window syntax those words can introduce. Include cases after function calls and before named window declarations.

## VS Code support

The [VS Code extension](apps/vscode/README.md) reports parser errors, shows declarations and explicit columns in Outline, and resolves foreign key table and column definitions across the configured SQLite schema. The providers use an editor-independent language service.

The extension-host test exercises F12 on both names in `REFERENCES users(id)` in the [multipart demo](apps/demo/examples/multipart/schema/blog/posts.uncut.sql). It checks the closed target on disk, then moves the declaration in an unsaved buffer and verifies the new positions. It also checks Outline, syntax diagnostics and recovery after a correction.

Use feedback from this milestone to decide whether to index references next. Revisit project-wide rename and completion inside views after assessing name resolution. The long-term plan is to expose the language service through an LSP server for VS Code and other editors.

## Project roadmaps

Each project maintains its priorities and completion status in its README. Update this file when a workspace milestone, its order, or a dependency between projects changes.

- [Codec](libs/codec/README.md#roadmap)
- [Core](libs/core/README.md#roadmap)
- [SQLite dialect](libs/sqlite/README.md#roadmap)
- [SQLite driver](libs/sqlite-driver/README.md#roadmap)
- [CLI](libs/cli/README.md#roadmap)
- [Demo](apps/demo/README.md#roadmap)
- [VS Code extension](apps/vscode/README.md#roadmap)
