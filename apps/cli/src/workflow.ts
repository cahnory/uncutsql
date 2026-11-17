import { Effect, Result } from "effect";
import {
  diffDatabases,
  planDatabaseMigration,
  SchemaDiffError,
  type DatabaseSchema,
  type DatabaseDiff,
  type Dialect,
  type DiffDiagnostic,
} from "@uncutsql/core";

export interface Comparison {
  readonly before: DatabaseSchema;
  readonly after: DatabaseSchema;
  readonly diff: DatabaseDiff;
}

/** Consumer-owned composition: the dialect contributes conversion, core compares. */
export const compareSchemas = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  before: Ast,
  after: Ast,
): Effect.Effect<Comparison, E | SchemaDiffError, R> =>
  Effect.gen(function* () {
    const diagnostics: DiffDiagnostic[] = [];
    const databases: DatabaseSchema[] = [];
    for (const [ast, side] of [
      [before, "before"],
      [after, "after"],
    ] as const) {
      const result = yield* Effect.result(dialect.toDatabaseSchema(ast, side));
      if (Result.isSuccess(result)) databases.push(result.success);
      else if (result.failure instanceof SchemaDiffError)
        diagnostics.push(...result.failure.diagnostics);
      else return yield* Effect.fail(result.failure);
    }
    if (diagnostics.length) return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    const previous = databases[0]!;
    const next = databases[1]!;
    const diff = yield* diffDatabases(previous, next);
    return { before: previous, after: next, diff };
  });

/** Core describes intent; the selected dialect chooses and renders physical operations. */
export const renderMigration = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  comparison: Comparison,
): Effect.Effect<string, E, R> =>
  Effect.gen(function* () {
    const procedures = planDatabaseMigration(comparison.diff);
    const plan = yield* dialect.lowerMigration(procedures, comparison.before, comparison.after);
    return yield* dialect.encodeMigration(plan);
  });
