import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Data, Effect } from "effect";

import { decodeDatabaseSchema, validateDatabase } from "@uncutsql/core";
import type { DatabaseSchema } from "@uncutsql/core";

export class GenerationError extends Data.TaggedError("GenerationError")<{
  readonly message: string;
}> {}
export interface SchemaLock {
  readonly database: DatabaseSchema;
  readonly dialect: string;
  readonly formatVersion: 2;
  readonly lastMigrationId: number;
  readonly lastMigrationSha256: string;
}
export const migrationFilename = (id: number) => `${String(id).padStart(6, "0")}.sql`;
export const hashMigration = (sql: string) =>
  createHash("sha256").update(sql, "utf8").digest("hex");

/** The consumer owns lock metadata; core validates the embedded database model. */
export const decodeLock = (
  source: string,
  dialect?: string,
): Effect.Effect<SchemaLock, GenerationError> =>
  Effect.gen(function* () {
    const value: unknown = yield* Effect.try({
      catch: () => new GenerationError({ message: "Lock file is not valid JSON" }),
      try: () => JSON.parse(source),
    });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return yield* Effect.fail(new GenerationError({ message: "Invalid lock file object" }));
    }
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
      item.formatVersion !== 2 ||
      typeof item.dialect !== "string" ||
      typeof item.lastMigrationId !== "number" ||
      !Number.isSafeInteger(item.lastMigrationId) ||
      item.lastMigrationId < 1 ||
      typeof item.lastMigrationSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.lastMigrationSha256)
    ) {
      return yield* Effect.fail(
        new GenerationError({
          message: "Unsupported or malformed lock format (expected version 2)",
        }),
      );
    }
    if (dialect !== undefined && item.dialect !== dialect) {
      return yield* Effect.fail(
        new GenerationError({
          message: `Lock dialect ${JSON.stringify(item.dialect)} does not match ${JSON.stringify(dialect)}`,
        }),
      );
    }
    const database = yield* decodeDatabaseSchema(item.database).pipe(
      Effect.mapError(
        (error) => new GenerationError({ message: `Invalid lock database: ${error.message}` }),
      ),
    );
    const diagnostics = validateDatabase(database, "before");
    if (diagnostics.length) {
      return yield* Effect.fail(
        new GenerationError({ message: diagnostics.map((item) => item.message).join("\n") }),
      );
    }
    return {
      database,
      dialect: item.dialect,
      formatVersion: 2,
      lastMigrationId: item.lastMigrationId,
      lastMigrationSha256: item.lastMigrationSha256,
    };
  });

export const schemaDigest = (database: DatabaseSchema) =>
  hashMigration(
    JSON.stringify(database, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value,
    ),
  );

/** Hash the exact generated UTF-8 text, rejecting malformed byte sequences. */
export const readMigrationFile = async (filename: string, tip?: SchemaLock) => {
  const bytes = await readFile(filename);
  const sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const sha256 = hashMigration(sql);
  if (tip && sha256 !== tip.lastMigrationSha256) {
    throw new Error(`${filename}: content does not match the lock's migration hash`);
  }
  const match = /^-- uncutsql-chain v1 (root|[a-f0-9]{64}) ([a-f0-9]{64})\n/.exec(sql);
  if (!match) {
    throw new Error(`${filename}: invalid migration chain header`);
  }
  if (tip && match[2] !== schemaDigest(tip.database)) {
    throw new Error(`${filename}: schema snapshot does not match the migration lock`);
  }
  return { parent: match[1], sha256, sql };
};

export const readDownMigration = (source: string): { sql: string } | { reason: string } => {
  const [header, ...lines] = source.slice(source.indexOf("\n") + 1).split("\n");
  if (header?.startsWith("-- uncutsql-down unavailable: ")) {
    return { reason: header.slice("-- uncutsql-down unavailable: ".length) };
  }
  if (header !== "-- uncutsql-down v1") {
    return { reason: "This migration has no recorded down SQL." };
  }
  const end = lines.indexOf("-- uncutsql-up");
  const body = lines.slice(0, end);
  if (end < 1 || body.some((line) => !line.startsWith("-- | "))) {
    throw new Error("Malformed down migration");
  }
  const sql = body.map((line) => line.slice(5)).join("\n");
  if (!sql.trim()) {
    throw new Error("Empty down migration");
  }
  return { sql };
};
