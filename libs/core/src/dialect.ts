import type { Effect } from "effect";
import type { DatabaseSchema } from "./model.ts";
import type { DatabaseMigration } from "./migration.ts";
import type { DiffDiagnostic } from "./diff.ts";

/** Dialect capabilities. The caller owns comparison and logical planning. */
export interface Dialect<Ast, PhysicalPlan, E extends Error = Error, R = never> {
  readonly name: string;
  readonly supportsDropGuards?: boolean;
  readonly parse: (source: string) => Effect.Effect<Ast, E, R>;
  /** Combine independently parsed schema documents in source order. */
  readonly combineSchemas?: (parts: readonly Ast[]) => Ast;
  readonly format: (ast: Ast) => Effect.Effect<string, E, R>;
  readonly toDatabaseSchema: (
    ast: Ast,
    side?: DiffDiagnostic["side"],
  ) => Effect.Effect<DatabaseSchema, E, R>;
  readonly lowerMigration: (
    migration: DatabaseMigration,
    before: DatabaseSchema,
    after: DatabaseSchema,
  ) => Effect.Effect<PhysicalPlan, E, R>;
  readonly encodeMigration: (plan: PhysicalPlan) => Effect.Effect<string, E, R>;
}
