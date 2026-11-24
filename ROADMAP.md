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

Implicit `WINDOW`, `FILTER` and `OVER` aliases now use token lookahead to preserve window clauses after function calls and before named window declarations.

Named window declarations, references and base windows now accept contextual keywords and single-quoted names according to their grammar position. Tests compare keyword names with native SQLite and verify that formatting preserves the spelling of each window name.

Table declarations and query sources now accept contextual keywords in both parts of a qualified relation name. Tests compare every dialect keyword with native SQLite, including names beside a join. A leading `IF` in a declaration starts `IF NOT EXISTS`. After the clause or a schema qualifier, `If` can name the relation.

Table and view column declarations, both sides of foreign keys, and the table after `CREATE INDEX … ON` now accept contextual keywords. The dialect tests compare every keyword with native SQLite and verify that formatting preserves schema metadata. The editor tests cover Outline and foreign key navigation for these names.

Named column and table constraints now accept contextual and single-quoted names. The dialect tests compare every keyword in both positions with native SQLite and check that formatting preserves the name.

Trailing constraint labels are accepted in column and table declarations. Canonical SQL drops labels that have no effect on neighboring constraints. Native SQLite tests check column metadata and the names reported for neighboring CHECK failures. A table-level label still closes the column list.

Consecutive constraint labels now use the last name. Adjacent bodies inherit it, including the first table constraint after the final column. A new column or a comma between table constraints clears the label. The formatter preserves these boundaries, and native SQLite tests exercise each CHECK failure before and after formatting.

Foreign key MATCH names now accept contextual keywords and single-quoted names. Tests compare every dialect keyword with native SQLite and check the option name and order in the AST after formatting. SQLite reports NONE for the mode in foreign_key_list.

Index hints after `INDEXED BY` now accept contextual keywords and single-quoted index names. Tests create an index for every dialect keyword, compare bare and quoted hint acceptance with native SQLite, and verify that formatting preserves the selected index in the query plan.

Next, cover column names in `JOIN … USING` in `libs/sqlite/src/codecs/query/join-constraint.ts`. With an `abort` column in both tables, native SQLite accepts `USING (Abort)` and `USING ('abort')`. The query codec rejects both. Compare keyword acceptance with SQLite and verify that formatted multi-column joins return the same matching rows.

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
