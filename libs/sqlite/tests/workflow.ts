// Test consumers wire core and the dialect exactly as an application would.
import { Effect, Result } from "effect";

import { diffDatabases, planDatabaseMigration, SchemaDiffError } from "@uncutsql/core";
import type { DatabaseSchema, DiffDiagnostic } from "@uncutsql/core";

import { lowerMigration, toDatabaseSchema } from "../src/index.ts";
import type { Statement } from "../src/index.ts";

const compare = (before: readonly Statement[], after: readonly Statement[]) =>
  Effect.gen(function* () {
    const diagnostics: DiffDiagnostic[] = [];
    const models: DatabaseSchema[] = [];
    for (const [ast, side] of [
      [before, "before"],
      [after, "after"],
    ] as const) {
      const result = yield* Effect.result(toDatabaseSchema(ast, side));
      if (Result.isSuccess(result)) {
        models.push(result.success);
      } else if (result.failure instanceof SchemaDiffError) {
        diagnostics.push(...result.failure.diagnostics);
      } else {
        return yield* Effect.fail(result.failure);
      }
    }
    if (diagnostics.length) {
      return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    }
    return {
      after: models[1]!,
      before: models[0]!,
      diff: yield* diffDatabases(models[0]!, models[1]!),
    };
  });
export const diffSchemas = (before: readonly Statement[], after: readonly Statement[]) =>
  Effect.map(compare(before, after), (result) => result.diff);
export const planMigration = (before: readonly Statement[], after: readonly Statement[]) =>
  Effect.gen(function* () {
    const comparison = yield* compare(before, after);
    return yield* lowerMigration(
      planDatabaseMigration(comparison.diff),
      comparison.before,
      comparison.after,
    );
  });
