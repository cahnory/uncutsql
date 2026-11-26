import { mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import type { MigrationExecutor } from "@uncutsql/core";

import { loadRange } from "./apply.ts";
import {
  checkMigrationFiles,
  readMigrationLock,
  syncDirectory,
  withMigrationDirectoryLock,
  writeNew,
} from "./generate.ts";
import { baselineFilename, GenerationError, hashMigration, migrationFilename } from "./lock.ts";
import type { SchemaLock } from "./lock.ts";

export interface CompactionPreview {
  readonly baselinePath: string;
  readonly id: number;
  readonly lockPath: string;
  readonly removed: readonly string[];
}

const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) =>
      new GenerationError({ message: cause instanceof Error ? cause.message : String(cause) }),
    try: operation,
  });

const publish = async (
  directory: string,
  { baselinePath, id, lockPath, removed }: CompactionPreview,
  lock: SchemaLock,
  sql: string,
) => {
  const stage = await mkdtemp(join(directory, ".compact-"));
  let published = false;
  let committed = false;
  try {
    await writeNew(join(stage, "lock"), JSON.stringify(lock, null, 2) + "\n");
    await writeNew(baselinePath, sql);
    published = true;
    await syncDirectory(directory);
    await rename(join(stage, "lock"), lockPath);
    committed = true;
    await syncDirectory(directory);
    for (const file of removed) {
      await unlink(file);
    }
    await syncDirectory(directory);
  } catch (error) {
    if (committed) {
      throw new Error(
        `Baseline published. Remove remaining superseded migration files through ${id}: ${error}`,
      );
    }
    if (published) {
      await unlink(baselinePath);
    }
    throw error;
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
};

export const compactGenerated = (
  executor: MigrationExecutor,
  directory: string,
  id: number,
  confirm: (preview: CompactionPreview) => Effect.Effect<boolean, Error>,
) =>
  withMigrationDirectoryLock(
    directory,
    false,
    Effect.gen(function* () {
      const lock = yield* readMigrationLock(directory, executor.dialect);
      if (!executor.compact) {
        return yield* Effect.fail(
          new GenerationError({ message: "Driver does not support compaction" }),
        );
      }
      if (
        !Number.isSafeInteger(id) ||
        id <= (lock.baseline?.id ?? 1) ||
        id > lock.lastMigrationId
      ) {
        return yield* Effect.fail(
          new GenerationError({
            message:
              "Choose an existing migration ID beyond the first migration or current baseline",
          }),
        );
      }
      yield* checkMigrationFiles(directory, lock);
      const sources = yield* loadRange(directory, lock, { id: 0, sha256: null }, "up");
      const prefix = sources.filter((file) => file.id <= id);
      const removed = prefix.map((file) =>
        join(
          directory,
          file.id === lock.baseline?.id ? baselineFilename(file.id) : migrationFilename(file.id),
        ),
      );
      const baselinePath = join(directory, baselineFilename(id));
      const lockPath = join(directory, "uncutsql.lock.json");
      const preview = { baselinePath, id, lockPath, removed };
      if (!(yield* confirm(preview))) {
        return false;
      }
      const tip = prefix[prefix.length - 1]!;
      const rendered = yield* executor.compact(prefix);
      const sql = `-- uncutsql-chain v1 root ${tip.schemaHash}\n${rendered}`;
      const baseline = { checkpoint: tip.sha256, id, sha256: hashMigration(sql) };
      yield* Effect.uninterruptible(
        io(() => publish(directory, preview, { ...lock, baseline }, sql)),
      );
      return true;
    }),
  );
