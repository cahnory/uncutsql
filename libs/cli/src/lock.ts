import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import { decodeDatabaseSchema, validateDatabase, type DatabaseSchema } from "@uncutsql/core";

export class GenerationError extends Data.TaggedError("GenerationError")<{
  readonly message: string;
}> {}
export interface SchemaLock {
  readonly formatVersion: 1;
  readonly dialect: string;
  readonly lastMigrationId: number;
  readonly lastMigrationSha256: string;
  readonly database: DatabaseSchema;
}
export const migrationFilename = (id: number) => `${String(id).padStart(6, "0")}.sql`;
export const hashMigration = (sql: string) =>
  createHash("sha256").update(sql, "utf8").digest("hex");

/** The consumer owns lock metadata; core validates the embedded database model. */
export const decodeLock = (
  source: string,
  dialect: string,
): Effect.Effect<SchemaLock, GenerationError> =>
  Effect.gen(function* () {
    const value: unknown = yield* Effect.try({
      try: () => JSON.parse(source),
      catch: () => new GenerationError({ message: "Lock file is not valid JSON" }),
    });
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return yield* Effect.fail(new GenerationError({ message: "Invalid lock file object" }));
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).some(
        (key) =>
          ![
            "formatVersion",
            "dialect",
            "lastMigrationId",
            "lastMigrationSha256",
            "database",
          ].includes(key),
      ) ||
      item.formatVersion !== 1 ||
      typeof item.dialect !== "string" ||
      typeof item.lastMigrationId !== "number" ||
      !Number.isSafeInteger(item.lastMigrationId) ||
      item.lastMigrationId < 1 ||
      typeof item.lastMigrationSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.lastMigrationSha256)
    ) {
      return yield* Effect.fail(
        new GenerationError({
          message: "Unsupported or malformed lock format (expected version 1)",
        }),
      );
    }
    if (item.dialect !== dialect)
      return yield* Effect.fail(
        new GenerationError({
          message: `Lock dialect ${JSON.stringify(item.dialect)} does not match ${JSON.stringify(dialect)}`,
        }),
      );
    const database = yield* decodeDatabaseSchema(item.database).pipe(
      Effect.mapError(
        (error) => new GenerationError({ message: `Invalid lock database: ${error.message}` }),
      ),
    );
    const diagnostics = validateDatabase(database, "before");
    if (diagnostics.length)
      return yield* Effect.fail(
        new GenerationError({ message: diagnostics.map((item) => item.message).join("\n") }),
      );
    return {
      formatVersion: 1,
      dialect: item.dialect,
      lastMigrationId: item.lastMigrationId,
      lastMigrationSha256: item.lastMigrationSha256,
      database,
    };
  });
