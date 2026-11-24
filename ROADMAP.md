# Workspace roadmap

The next workspace milestone is to migrate schemas containing views, including table rebuilds that preserve dependent views. SQLite already parses and formats view declarations.

| Milestone | Handoff |
| --- | --- |
| 1. Generate migrations for views | Core defines how snapshots and logical changes represent views. SQLite can then map declarations to that model and generate ordered migration SQL. |
| 2. Apply and verify view migrations | Once SQLite can model and render views, the SQLite driver can verify them against a live database. The CLI can test generation once the dialect is ready and the full apply workflow once the driver is ready. The demo can then show the verified workflow. |
| 3. Preserve triggers during migrations | Follow the view milestone with triggers. SQLite trigger grammar and core model work can proceed independently. SQLite lowering needs both, followed by driver verification and CLI integration. |

SQLite contextual keyword and legacy quoting work can proceed independently of these handoffs.

## Project roadmaps

Each project maintains its priorities and completion status in its README. Update this file when a workspace milestone, its order, or a dependency between projects changes.

- [Codec](libs/codec/README.md#roadmap)
- [Core](libs/core/README.md#roadmap)
- [SQLite dialect](libs/sqlite/README.md#roadmap)
- [SQLite driver](libs/sqlite-driver/README.md#roadmap)
- [CLI](libs/cli/README.md#roadmap)
- [Demo](apps/demo/README.md#roadmap)
