# @uncutsql/core

Dialect-independent database models, structural comparison and logical migration
procedures. The only runtime dependency is Effect. No SQL parser, codec, dialect,
filesystem or database driver is imported here.

`DatabaseSchema` contains tables, standalone indexes, columns, constraints and option properties.
Table identities distinguish catalog and schema. Each dialect adapter supplies
normalized table identities and column keys; core does not infer namespaces or
fold case. Types and constraint properties use serializable structured values.
Namespaced option keys retain dialect features without hardcoding their meaning.
Object property order is ignored, while array order remains significant.

```ts
import { resolveMigrationDecisions, planDatabaseMigration } from "@uncutsql/core";

const { diff } = yield * resolveMigrationDecisions(beforeDatabase, afterDatabase, decisions);
const migration = planDatabaseMigration(diff);
// migration.procedures: CreateTable | DropTable | AlterTable | RenameTable
```

The logical procedures express requested changes. Each dialect chooses physical
operations, dependency order, rebuild strategy and SQL rendering. Cross-dialect
semantic equivalence is not inferred: adapters must agree on normalized values
before comparison. Views carry a query, and triggers carry a target identity and a
dialect-normalized definition. Changes to either trigger field produce a ReplaceTrigger procedure.

```sh
pnpm --filter @uncutsql/core check
pnpm --filter @uncutsql/core build
```

`Dialect<Ast, PhysicalPlan, E, R>` is the capability contract for interchangeable
adapters: parse/format SQL, convert ASTs to the shared model, lower logical
procedures and render a physical plan. Users own the composition. Core never
selects or imports a dialect, and dialect packages must not run the core diff or
logical planner on behalf of callers. The CLI demonstrates the wiring and tests
its workflow with a separate fixture adapter that has a different AST and plan.

`decodeDatabaseSchema(unknown)` validates JSON-restored/external model shapes and
serializable semantic values with path-based SchemaModelError failures. Model
validation is separate from duplicate-identity checking in the diff. Lock versions,
dialect IDs, migration history and filesystem persistence remain consumer concerns.

`MigrationExecutor` is a separate optional runtime contract. Consumers provide the
full ordered MigrationSource history and a schema-verification callback, leaving
core comparison in the application. An executor owns connections, physical
transactions and applied-history recording. It is selected independently from the
syntax dialect; core itself has no database driver or filesystem dependency.

## Migration decisions

`prepareMigrationDecisions(before, after)` returns a versioned JSON document with
both schema snapshots and structured questions for removed tables and columns.
Column questions list all added keys in that table as candidates; no similarity
heuristic selects a rename. Each `resolution` starts as `{ "action": "pending" }`.

Table questions list added table names in the same namespace. Consumers choose
`drop`, `drop_if_empty`, or `rename` with a listed target. After choosing a table
rename, `mergeMigrationDecisions` adds questions for columns removed from that
table and retains reviewed answers for the same source and target. Then
`resolveMigrationDecisions(before, after, document)` validates the untrusted
answers and snapshots and returns a resolved diff and sanitized decision record.
Missing, stale, duplicate or conflicting answers fail with MigrationDecisionError;
its `pending` field carries the review document. Additions alone need no answers.

Table renames become RenameTable procedures. Column renames become ColumnRenamed alterations, including separate dataType/constraints
change fields. The desired schema remains authoritative: rename decisions do not
rewrite desired CHECK expressions or foreign-key references. Custom transformations, similarity ranking and automatic approval are not provided.

Core has no prompts or persistence. `planDatabaseMigration` remains a low-level
primitive for caller-approved intent; user-facing workflows should resolve
choices before calling it. The CLI enforces this sequence for migration/generate.

## Roadmap

- [x] Represent views in serializable database snapshots, validate restored snapshots, and describe view changes in the diff and logical plan.
- [x] Represent trigger snapshots, validate restored models and lower trigger diffs to logical procedures.

See the [workspace roadmap](../../ROADMAP.md) for cross-project sequencing.
