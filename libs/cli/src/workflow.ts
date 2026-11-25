import { Effect, Result } from "effect";

import {
  diffDatabases,
  MigrationDecisionError,
  planDatabaseMigration,
  planDownMigration,
  resolveMigrationDecisions,
  SchemaDiffError,
} from "@uncutsql/core";
import type { DatabaseDiff, DatabaseSchema, Dialect, DiffDiagnostic } from "@uncutsql/core";

export interface Comparison {
  readonly after: DatabaseSchema;
  readonly before: DatabaseSchema;
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
      if (Result.isSuccess(result)) {
        databases.push(result.success);
      } else if (result.failure instanceof SchemaDiffError) {
        diagnostics.push(...result.failure.diagnostics);
      } else {
        return yield* Effect.fail(result.failure);
      }
    }
    if (diagnostics.length) {
      return yield* Effect.fail(new SchemaDiffError({ diagnostics }));
    }
    const previous = databases[0]!;
    const next = databases[1]!;
    const diff = yield* diffDatabases(previous, next);
    return { after: next, before: previous, diff };
  });

/** Core describes intent; the selected dialect chooses and renders physical operations. */
export const renderMigration = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  comparison: Comparison,
  decisions?: unknown,
): Effect.Effect<string, E | SchemaDiffError | MigrationDecisionError, R> =>
  Effect.map(renderUp(dialect, comparison, decisions), (result) => result.sql);

const renderUp = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  comparison: Comparison,
  decisions?: unknown,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveMigrationDecisions(
      comparison.before,
      comparison.after,
      decisions,
    );
    const procedures = planDatabaseMigration(resolved.diff);
    if (procedures.dropGuards?.length && dialect.supportsDropGuards !== true) {
      return yield* Effect.fail(
        new MigrationDecisionError({
          message: `Dialect ${dialect.name} does not support drop_if_empty.`,
          pending: resolved.decisions,
        }),
      );
    }
    const plan = yield* dialect.lowerMigration(procedures, comparison.before, comparison.after);
    const sql = yield* dialect.encodeMigration(plan);
    if (!sql.trim()) {
      return { procedures, sql };
    }
    // Persist the validated choices inside the hashed migration, using a single JSON comment.
    const metadata = resolved.decisions.decisions.length
      ? `-- uncutsql-decisions: ${JSON.stringify(resolved.decisions).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")}\n`
      : "";
    return { procedures, sql: metadata + sql };
  });

// Keep the complete pair under the existing file checksum. SQL clients execute only up.
export const renderMigrationFile = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  comparison: Comparison,
  decisions?: unknown,
) =>
  Effect.gen(function* () {
    const up = yield* renderUp(dialect, comparison, decisions);
    if (!up.sql.trim()) {
      return up.sql;
    }
    const down = planDownMigration(up.procedures);
    const unavailable = (reason: string) =>
      `-- uncutsql-down unavailable: ${reason.replace(/[\r\n]+/g, " ")}\n${up.sql}`;
    if (typeof down === "string") {
      return unavailable(down);
    }
    if (down.dropGuards?.length && !dialect.supportsDropGuards) {
      return unavailable(`Dialect ${dialect.name} cannot guard destructive drops.`);
    }
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const plan = yield* dialect.lowerMigration(down, comparison.after, comparison.before);
        return yield* dialect.encodeMigration(plan);
      }),
    );
    if (Result.isFailure(result)) {
      return unavailable(result.failure.message);
    }
    if (!result.success.trim()) {
      return unavailable("The dialect returned empty down SQL.");
    }
    const commented = result.success
      .split("\n")
      .map((line) => `-- | ${line}`)
      .join("\n");
    return `-- uncutsql-down v1\n${commented}\n-- uncutsql-up\n${up.sql}`;
  });
