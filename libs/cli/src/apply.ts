import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect } from "effect";

import { diffDatabases } from "@uncutsql/core";
import type { MigrationExecutor, MigrationSource } from "@uncutsql/core";

import { readBaseline, withMigrationDirectoryLock } from "./generate.ts";
import { hashMigration, migrationFilename, readDownMigration } from "./lock.ts";

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly message: string;
}> {}

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
        const baseline = yield* readBaseline(directory, executor.dialect);
        if (baseline.lastMigrationId === 0) {
          return yield* Effect.fail(
            new ApplicationError({
              message: "No generated baseline found; generate migrations first",
            }),
          );
        }
        const migrations = yield* Effect.tryPromise({
          catch: (cause) =>
            new ApplicationError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          try: async () => {
            const files: MigrationSource[] = [];
            for (let id = 1; id <= baseline.lastMigrationId; id++) {
              const sql = await readFile(join(directory, migrationFilename(id)), "utf8");
              files.push({ down: readDownMigration(sql), id, sha256: hashMigration(sql), sql });
            }
            return files;
          },
        });
        return { database: baseline.database, migrations };
      }),
    );
    return yield* execute.bind(executor)(
      target,
      loaded.migrations,
      loaded.database,
      (actual, expected, stage) =>
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
                message: `Database schema differs from the ${stage === "applied" ? "last applied snapshot" : "generation lock"}: ${descriptions.join(", ")}`,
              }),
            );
          }
        }),
    );
  });
