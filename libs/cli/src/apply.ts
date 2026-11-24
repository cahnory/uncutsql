import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { diffDatabases, type MigrationExecutor, type MigrationSource } from "@uncutsql/core";
import { readBaseline, withMigrationDirectoryLock } from "./generate.ts";
import { hashMigration, migrationFilename } from "./lock.ts";

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly message: string;
}> {}

/** File loading and core verification belong to the consumer, not the execution driver. */
export const applyGenerated = <E extends Error, R>(
  executor: MigrationExecutor<E, R>,
  target: string,
  directory: string,
) =>
  Effect.gen(function* () {
    const loaded = yield* withMigrationDirectoryLock(
      directory,
      false,
      Effect.gen(function* () {
        const baseline = yield* readBaseline(directory, executor.dialect);
        if (baseline.lastMigrationId === 0)
          return yield* Effect.fail(
            new ApplicationError({
              message: "No generated baseline found; generate migrations first",
            }),
          );
        const migrations = yield* Effect.tryPromise({
          try: async () => {
            const files: MigrationSource[] = [];
            for (let id = 1; id <= baseline.lastMigrationId; id++) {
              const sql = await readFile(join(directory, migrationFilename(id)), "utf8");
              files.push({ id, sql, sha256: hashMigration(sql) });
            }
            return files;
          },
          catch: (cause) =>
            new ApplicationError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        return { migrations, database: baseline.database };
      }),
    );
    return yield* executor.apply(
      target,
      loaded.migrations,
      loaded.database,
      (actual, expected, stage) =>
        Effect.gen(function* () {
          const diff = yield* diffDatabases(expected, actual);
          if (diff.changes.length)
            return yield* Effect.fail(
              new ApplicationError({
                message: `Database schema differs from the ${stage === "applied" ? "last applied snapshot" : "generation lock"}: ${diff.changes.map((change) => `${change._tag} ${JSON.stringify(change.table)}`).join(", ")}`,
              }),
            );
        }),
    );
  });
