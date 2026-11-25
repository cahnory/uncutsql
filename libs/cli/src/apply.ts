import { join } from "node:path";

import { Data, Effect } from "effect";

import { diffDatabases } from "@uncutsql/core";
import type {
  DatabaseSchema,
  MigrationCheckpoint,
  MigrationExecutor,
  MigrationSource,
} from "@uncutsql/core";

import { checkMigrationFiles, readMigrationLock, withMigrationDirectoryLock } from "./generate.ts";
import {
  migrationFilename,
  readCompactedBaseline,
  readDownMigration,
  readMigrationFile,
} from "./lock.ts";
import type { SchemaLock } from "./lock.ts";

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly message: string;
}> {}

export const loadRange = (
  directory: string,
  lock: SchemaLock,
  checkpoint: MigrationCheckpoint,
  mode: "up" | "down" | "verify",
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ApplicationError({ message: cause instanceof Error ? cause.message : String(cause) }),
    try: async () => {
      if (checkpoint.id > lock.lastMigrationId) {
        throw new Error("Database checkpoint is ahead of the migration lock");
      }
      const files: (MigrationSource & { schemaHash: string })[] = [];
      const down = mode === "down";
      const baseline = lock.baseline;
      if (baseline && checkpoint.id > 0 && checkpoint.id < baseline.id) {
        throw new Error(
          `Database is at migration ${checkpoint.id}. Use the pre-compaction migrations to reach ${baseline.id} before upgrading.`,
        );
      }
      if (baseline && checkpoint.id === baseline.id) {
        if (checkpoint.sha256 !== baseline.checkpoint) {
          throw new Error("Database checkpoint differs from the compacted prefix");
        }
        if (down) {
          throw new Error(`Cannot roll back past compacted baseline ${baseline.id}.`);
        }
      }
      let first = down ? Math.max(1, checkpoint.id) : checkpoint.id + 1;
      const last = down ? checkpoint.id : lock.lastMigrationId;
      let parent = checkpoint.sha256;
      if (baseline && !down && checkpoint.id === 0) {
        const file = await readCompactedBaseline(directory, lock);
        files.push({
          baselineCheckpoint: baseline.checkpoint,
          id: baseline.id,
          schemaHash: file.schemaHash,
          sha256: file.sha256,
          sql: file.sql,
        });
        parent = baseline.checkpoint;
        first = baseline.id + 1;
      }
      for (let id = first; id <= last; id++) {
        const path = join(directory, migrationFilename(id));
        const {
          parent: recordedParent,
          schemaHash,
          sha256,
          sql,
        } = await readMigrationFile(path, id === lock.lastMigrationId ? lock : undefined);
        if (down && sha256 !== checkpoint.sha256) {
          throw new Error(`${path}: migration hash does not match the recorded digest`);
        }
        if (!down && recordedParent !== (parent ?? "root")) {
          throw new Error(`${path}: parent hash does not match migration ${id - 1}`);
        }
        parent = sha256;
        if (mode !== "verify") {
          files.push({ down: readDownMigration(sql), id, schemaHash, sha256, sql });
        }
      }
      if (
        checkpoint.id === lock.lastMigrationId &&
        checkpoint.sha256 !== lock.lastMigrationSha256
      ) {
        throw new Error("Database checkpoint does not match the migration lock");
      }
      return files;
    },
  });

export const verifyGenerated = (directory: string) =>
  withMigrationDirectoryLock(
    directory,
    false,
    Effect.gen(function* () {
      const lock = yield* readMigrationLock(directory);
      yield* checkMigrationFiles(directory, lock);
      yield* loadRange(directory, lock, { id: 0, sha256: null }, "verify");
      return lock.lastMigrationId - (lock.baseline ? lock.baseline.id - 1 : 0);
    }),
  );

const verifySchema = (actual: DatabaseSchema, expected: DatabaseSchema, label: string) =>
  Effect.gen(function* () {
    const diff = yield* diffDatabases(expected, actual);
    if (diff.changes.length) {
      const descriptions = diff.changes.map((change) => {
        const identity =
          "table" in change
            ? change.table
            : "view" in change
              ? change.view.identity
              : "trigger" in change
                ? change.trigger.identity
                : change.after.identity;
        return `${change._tag} ${JSON.stringify(identity)}`;
      });
      return yield* Effect.fail(
        new ApplicationError({
          message: `Database schema differs from the ${label}: ${descriptions.join(", ")}`,
        }),
      );
    }
  });

/** File loading and core verification belong to the consumer, not the execution driver. */
export const applyGenerated = <E extends Error, R>(
  executor: MigrationExecutor<E, R>,
  target: string,
  directory: string,
  direction: "up" | "down" = "up",
) =>
  Effect.gen(function* () {
    const execute = direction === "down" ? executor.rollback : executor.apply;
    if (typeof execute !== "function") {
      return yield* Effect.fail(
        new ApplicationError({ message: "This driver does not support down migrations." }),
      );
    }
    const loaded = yield* withMigrationDirectoryLock(
      directory,
      false,
      Effect.gen(function* () {
        const baseline = yield* readMigrationLock(directory, executor.dialect);
        const checkpoint = yield* executor.checkpoint(target);
        const migrations = yield* loadRange(directory, baseline, checkpoint, direction);
        return { checkpoint, database: baseline.database, migrations };
      }),
    );
    const result = yield* execute.bind(executor)(
      target,
      loaded.migrations,
      loaded.database,
      (actual, expected, stage) =>
        verifySchema(
          actual,
          expected,
          stage === "applied" ? "last applied snapshot" : "generation lock",
        ),
      loaded.checkpoint,
    );
    const first = loaded.migrations[0];
    return { ...result, ...(first?.baselineCheckpoint && { baselineId: first.id }) };
  });

export const adoptGenerated = (
  executor: MigrationExecutor,
  target: string,
  directory: string,
  id: number,
) =>
  withMigrationDirectoryLock(
    directory,
    false,
    Effect.gen(function* () {
      if (!executor.adopt) {
        return yield* Effect.fail(
          new ApplicationError({ message: "Driver does not support adoption" }),
        );
      }
      const lock = yield* readMigrationLock(directory, executor.dialect);
      if (!Number.isSafeInteger(id) || id < (lock.baseline?.id ?? 1) || id > lock.lastMigrationId) {
        return yield* Effect.fail(
          new ApplicationError({ message: "Choose a migration number in the available history" }),
        );
      }
      yield* checkMigrationFiles(directory, lock);
      const files = yield* loadRange(directory, lock, { id: 0, sha256: null }, "up");
      yield* executor.adopt(
        target,
        files.filter((file) => file.id <= id),
        (actual, expected) => verifySchema(actual, expected, `schema at migration ${id}`),
        id === lock.lastMigrationId ? lock.database : undefined,
      );
    }),
  );
