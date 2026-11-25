import type { Effect } from "effect";

import type { DatabaseSchema } from "./model.ts";

export interface MigrationSource {
  /** A root baseline records the original prefix tip as the logical checkpoint. */
  readonly baselineCheckpoint?: string;
  readonly down?: { readonly sql: string } | { readonly reason: string };
  readonly id: number;
  readonly sha256: string;
  readonly sql: string;
}
export interface MigrationCheckpoint {
  readonly id: number;
  readonly sha256: string | null;
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
    /** With a checkpoint, files start immediately after it (at it for rollback).
     * Recheck the database position under the write transaction before executing. */
    checkpoint?: MigrationCheckpoint,
  ) => Effect.Effect<ExecutionResult, E | V, R | RV>;
  readonly checkpoint: (target: string) => Effect.Effect<MigrationCheckpoint, E, R>;
  /** Replay a verified prefix on an empty database and render its state as one SQL migration. */
  readonly compact?: (migrations: readonly MigrationSource[]) => Effect.Effect<string, E, R>;
  readonly dialect: string;
  /** Undo only the most recently applied migration. */
  readonly rollback?: MigrationExecutor<E, R>["apply"];
}
