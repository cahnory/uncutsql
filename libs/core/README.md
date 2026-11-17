# @uncutsql/core

Dialect-independent database models, structural comparison and logical migration
procedures. The only runtime dependency is Effect. No SQL parser, codec, dialect,
filesystem or database driver is imported here.

`DatabaseSchema` contains tables, columns, constraints and option properties.
Table identities distinguish catalog and schema. Each dialect adapter supplies
normalized table identities and column keys; core does not infer namespaces or
fold case. Types and constraint properties use serializable structured values.
Namespaced option keys retain dialect features without hardcoding their meaning.
Object property order is ignored, while array order remains significant.

```ts
import { diffDatabases, planDatabaseMigration } from "@uncutsql/core";

const diff = yield * diffDatabases(beforeDatabase, afterDatabase);
const migration = planDatabaseMigration(diff);
// migration.procedures: CreateTable | DropTable | AlterTable
```

The logical procedures express requested changes. Each dialect chooses physical
operations, dependency order, rebuild strategy and SQL rendering. Cross-dialect
semantic equivalence is not inferred: adapters must agree on normalized values
before comparison. Other dialect parsers and additional objects such as standalone
indexes and views remain future work; the engine is independent of SQLite today.

```sh
pnpm --filter @uncutsql/core check
pnpm --filter @uncutsql/core build
```
