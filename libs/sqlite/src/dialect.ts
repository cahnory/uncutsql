import type { Dialect, SchemaDiffError } from "@uncutsql/core";
import type { EncodeError, ParseError } from "@uncutsql/codec";
import { schema, type Statement } from "./schema.ts";
import { toDatabaseSchema } from "./database.ts";
import {
  lowerMigration,
  encodeMigration,
  type MigrationPlan,
  type MigrationPlanError,
} from "./migration.ts";

export const dialect: Dialect<
  readonly Statement[],
  MigrationPlan,
  ParseError | EncodeError | SchemaDiffError | MigrationPlanError
> = {
  name: "sqlite",
  supportsDropGuards: true,
  parse: schema.decode,
  combineSchemas: (parts) => parts.flat(),
  format: schema.encode,
  toDatabaseSchema,
  lowerMigration,
  encodeMigration,
};
