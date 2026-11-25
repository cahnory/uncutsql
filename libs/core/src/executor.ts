import type { Effect } from "effect";

import type { DatabaseSchema } from "./model.ts";

export interface MigrationSource {
  readonly down?: { readonly sql: string } | { readonly reason: string };
  readonly id: number;
  readonly sha256: string;
  readonly sql: string;
}
export interface ExecutionResult {
  readonly appliedIds: readonly number[];
  readonly lastAppliedId: number;
  readonly rolledBackId?: number;
}

/** Optional execution capability, selected and wired by the consumer separately from syntax. */
export interface MigrationExecutor<E extends Error = Error, R = never> {
  readonly apply: <V extends Error, RV>(
    target: string,
    migrations: readonly MigrationSource[],
    desired: DatabaseSchema,
    verifySchema: (
      actual: DatabaseSchema,
      expected: DatabaseSchema,
      stage: "applied" | "desired",
    ) => Effect.Effect<void, V, RV>,
  ) => Effect.Effect<ExecutionResult, E | V, R | RV>;
  readonly dialect: string;
  /** Undo only the most recently applied migration. */
  readonly rollback?: MigrationExecutor<E, R>["apply"];
}
