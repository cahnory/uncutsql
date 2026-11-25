import { mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

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

const confirm = async (directory: string, id: number) => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  terminal.on("SIGINT", () => terminal.close());
  try {
    process.stderr.write(
      `Replace migrations 1–${id} in ${directory} with one baseline and delete the old files? Existing databases below ${id} must upgrade first. [y/N] `,
    );
    const answer = await terminal[Symbol.asyncIterator]().next();
    return !answer.done && /^(y|yes)$/i.test(answer.value.trim());
  } finally {
    terminal.close();
  }
};

const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) =>
      new GenerationError({ message: cause instanceof Error ? cause.message : String(cause) }),
    try: operation,
  });

const publish = async (directory: string, old: SchemaLock, lock: SchemaLock, sql: string) => {
  const id = lock.baseline!.id;
  const path = join(directory, baselineFilename(id));
  const stage = await mkdtemp(join(directory, ".compact-"));
  let published = false;
  let committed = false;
  try {
    await writeNew(join(stage, "lock"), JSON.stringify(lock, null, 2) + "\n");
    await writeNew(path, sql);
    published = true;
    await syncDirectory(directory);
    await rename(join(stage, "lock"), join(directory, "uncutsql.lock.json"));
    committed = true;
    await syncDirectory(directory);
    for (let index = (old.baseline?.id ?? 0) + 1; index <= id; index++) {
      await unlink(join(directory, migrationFilename(index)));
    }
    if (old.baseline) {
      await unlink(join(directory, baselineFilename(old.baseline.id)));
    }
    await syncDirectory(directory);
  } catch (error) {
    if (committed) {
      throw new Error(
        `Baseline published. Remove remaining superseded migration files through ${id}: ${error}`,
      );
    }
    if (published) {
      await unlink(path);
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
  yes: boolean,
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
      if (!yes && !(yield* io(() => confirm(directory, id)))) {
        return false;
      }
      const prefix = sources.filter((file) => file.id <= id);
      const tip = prefix[prefix.length - 1]!;
      const rendered = yield* executor.compact(prefix);
      const sql = `-- uncutsql-chain v1 root ${tip.schemaHash}\n${rendered}`;
      const baseline = { checkpoint: tip.sha256, id, sha256: hashMigration(sql) };
      yield* Effect.uninterruptible(io(() => publish(directory, lock, { ...lock, baseline }, sql)));
      return true;
    }),
  );
