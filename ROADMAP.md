# Workspace roadmap

View migrations now run through the CLI and SQLite driver. Snapshots, diffs and generated SQL include views, and the demo exercises a dependent view across a rebuild and a column rename.

The next workspace milestone is to preserve triggers during migrations.

| Step                                   | Handoff                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1. Represent and parse triggers        | Core defines serializable snapshots, diffs and logical procedures. SQLite trigger grammar and formatting can proceed independently. |
| 2. Generate trigger migrations         | SQLite maps declarations to the core model and orders trigger removal and recreation around table and view changes.                 |
| 3. Apply and verify trigger migrations | The driver inspects live triggers. The CLI and demo exercise generation, rebuild preservation and drift detection.                  |

SQLite contextual keyword and legacy quoting work can proceed independently of these handoffs.

## Project roadmaps

Each project maintains its priorities and completion status in its README. Update this file when a workspace milestone, its order, or a dependency between projects changes.

- [Codec](libs/codec/README.md#roadmap)
- [Core](libs/core/README.md#roadmap)
- [SQLite dialect](libs/sqlite/README.md#roadmap)
- [SQLite driver](libs/sqlite-driver/README.md#roadmap)
- [CLI](libs/cli/README.md#roadmap)
- [Demo](apps/demo/README.md#roadmap)
