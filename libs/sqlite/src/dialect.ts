import type { EncodeError, ParseError } from "@uncutsql/codec";
import type { Dialect, SchemaDiffError } from "@uncutsql/core";

import { toDatabaseSchema } from "./database.ts";
import { encodeMigration, lowerMigration } from "./migration.ts";
import type { MigrationPlan, MigrationPlanError } from "./migration.ts";
import { schema } from "./schema.ts";
import type { Statement } from "./schema.ts";

export const dialect: Dialect<
  readonly Statement[],
  MigrationPlan,
  ParseError | EncodeError | SchemaDiffError | MigrationPlanError
> = {
  combineSchemas: (parts) => parts.flat(),
  encodeMigration,
  format: schema.encode,
  lowerMigration,
  name: "sqlite",
  parse: schema.decode,
  supportsDropGuards: true,
  toDatabaseSchema,
};
