import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { decodeDatabaseSchema, diffDatabases, prepareMigrationDecisions } from "@uncutsql/core";
import type { Dialect } from "@uncutsql/core";

import {
  decodeLock,
  GenerationError,
  hashMigration,
  migrationFilename,
  readMigrationFile,
  schemaDigest,
} from "./lock.ts";
import type { SchemaLock } from "./lock.ts";
import { renderMigrationFile } from "./workflow.ts";

const lockName = "uncutsql.lock.json";
const writerName = ".uncutsql-generation.lock";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const hasCode = (cause: unknown, code: string) =>
  cause !== null && typeof cause === "object" && "code" in cause && cause.code === code;
const io = <A>(label: string, operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new GenerationError({ message: `${label}: ${message(cause)}` }),
    try: operation,
  });
const remove = async (path: string) => {
  try {
    await unlink(path);
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) {
      throw cause;
    }
  }
};
const readOptional = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
};
const syncDirectory = async (directory: string) => {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const writeNew = async (path: string, contents: string) => {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
  } catch (cause) {
    try {
      await handle.close();
    } catch {
      /* Preserve the write failure. */
    }
    try {
      await remove(path);
    } catch (cleanup) {
      throw new Error(`${message(cause)}; cleanup failed: ${message(cleanup)}`);
    }
    throw cause;
  }
};

export const numberedFiles = (directory: string) =>
  Effect.gen(function* () {
    return (yield* io(directory, async () => {
      try {
        return await readdir(directory);
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) {
          return [];
        }
        throw cause;
      }
    }))
      .filter((name) => /^\d+\.sql$/.test(name))
      .sort((left, right) => Number(left.slice(0, -4)) - Number(right.slice(0, -4)));
  });

export const readMigrationLock = (directory: string, dialect?: string) => {
  const path = join(directory, lockName);
  return io(path, () => readFile(path, "utf8")).pipe(
    Effect.flatMap((source) => decodeLock(source, dialect)),
  );
};

export const readBaseline = (directory: string, dialect: string) =>
  Effect.gen(function* () {
    const path = join(directory, lockName);
    const source = yield* io(path, () => readOptional(path));
    const files = yield* numberedFiles(directory);
    if (source === undefined) {
      if (files.length) {
        return yield* Effect.fail(
          new GenerationError({
            message: `${directory}: numbered migrations exist without a lock; restore the matching baseline before generating`,
          }),
        );
      }
      return { database: { tables: [] }, lastMigrationId: 0, lastMigrationSha256: undefined };
    }
    const lock = yield* decodeLock(source, dialect).pipe(
      Effect.mapError((error) => new GenerationError({ message: `${path}: ${error.message}` })),
    );
    if (
      files.length !== lock.lastMigrationId ||
      files.some((name, index) => name !== migrationFilename(index + 1))
    ) {
      return yield* Effect.fail(
        new GenerationError({
          message: `${directory}: numbered migration history does not match the lock; resolve missing or interrupted output before generating`,
        }),
      );
    }
    const latest = join(directory, migrationFilename(lock.lastMigrationId));
    yield* io(latest, () => readMigrationFile(latest, lock));
    return lock;
  });

const publish = async (directory: string, sql: string, lock: SchemaLock) => {
  const filename = migrationFilename(lock.lastMigrationId);
  const migrationPath = join(directory, filename);
  const stageSql = join(directory, `.${filename}.tmp`);
  const stageLock = join(directory, `.${lockName}.tmp`);
  let ownSql = false;
  let ownLock = false;
  let publishedSql = false;
  let committed = false;
  let failure: unknown;
  try {
    await writeNew(stageLock, `${JSON.stringify(lock, null, 2)}\n`);
    ownLock = true;
    await writeNew(stageSql, sql);
    ownSql = true;
    // A hard link publishes complete SQL atomically without replacing an existing file.
    await link(stageSql, migrationPath);
    publishedSql = true;
    await syncDirectory(directory);
    // This rename is the commit point, after the migration is present and synced.
    await rename(stageLock, join(directory, lockName));
    ownLock = false;
    committed = true;
  } catch (cause) {
    failure = cause;
  }
  const cleanup: unknown[] = [];
  for (const path of [
    ...(!committed && publishedSql ? [migrationPath] : []),
    ...(ownSql ? [stageSql] : []),
    ...(ownLock ? [stageLock] : []),
  ]) {
    try {
      await remove(path);
    } catch (cause) {
      cleanup.push(cause);
    }
  }
  try {
    await syncDirectory(directory);
  } catch (cause) {
    cleanup.push(cause);
  }
  if (failure !== undefined || cleanup.length) {
    throw new Error(
      [
        committed
          ? "Migration and lock were published, but cleanup failed"
          : "Generation was not committed",
        ...(failure === undefined ? [] : [message(failure)]),
        ...cleanup.map(message),
      ].join(": "),
    );
  }
};

export interface GenerationResult {
  readonly lockPath?: string;
  readonly migrationPath?: string;
}

/** Application-owned generation; no database is opened and no SQL is executed. */
export const generateMigration = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  ast: Ast,
  directory: string,
  decisions?: unknown,
) =>
  Effect.gen(function* () {
    const after = yield* dialect.toDatabaseSchema(ast, "after");
    yield* decodeDatabaseSchema(after).pipe(
      Effect.mapError((error) => new GenerationError({ message: error.message })),
    );
    return yield* withMigrationDirectoryLock(
      directory,
      true,
      Effect.gen(function* () {
        const baseline = yield* readBaseline(directory, dialect.name);
        const diff = yield* diffDatabases(baseline.database, after);
        if (!diff.changes.length && decisions === undefined) {
          return {} satisfies GenerationResult;
        }
        const id = baseline.lastMigrationId + 1;
        if (!Number.isSafeInteger(id)) {
          return yield* Effect.fail(
            new GenerationError({ message: "Migration ID range exhausted" }),
          );
        }
        const rendered = yield* renderMigrationFile(
          dialect,
          {
            after,
            before: baseline.database,
            diff,
          },
          decisions,
        );
        if (!diff.changes.length) {
          return {} satisfies GenerationResult;
        }
        if (!rendered.trim()) {
          return yield* Effect.fail(
            new GenerationError({
              message: "The dialect returned empty SQL for a nonempty schema diff",
            }),
          );
        }
        const parent = baseline.lastMigrationSha256 ?? "root";
        const sql = `-- uncutsql-chain v1 ${parent} ${schemaDigest(after)}\n${rendered}${rendered.endsWith("\n") ? "" : "\n"}`;
        const lock: SchemaLock = {
          database: after,
          dialect: dialect.name,
          formatVersion: 2,
          lastMigrationId: id,
          lastMigrationSha256: hashMigration(sql),
        };
        // Complete publication/cleanup before releasing the writer lock on interruption.
        yield* Effect.uninterruptible(io(directory, () => publish(directory, sql, lock)));
        return {
          lockPath: join(directory, lockName),
          migrationPath: join(directory, migrationFilename(id)),
        } satisfies GenerationResult;
      }),
    );
  });

/** Consumers share the same file lock while reading or publishing a generation snapshot. */
export const withMigrationDirectoryLock = <A, E, R>(
  directory: string,
  create: boolean,
  use: Effect.Effect<A, E, R>,
) => {
  const writerPath = join(directory, writerName);
  return Effect.acquireUseRelease(
    io(writerPath, async () => {
      if (create) {
        await mkdir(directory, { recursive: true });
      }
      try {
        return await open(writerPath, "wx");
      } catch (cause) {
        if (hasCode(cause, "EEXIST")) {
          throw new Error(
            "Another command is reading or generating migrations, or was interrupted. Inspect the output and remove this writer lock only when no command is using the directory.",
          );
        }
        throw cause;
      }
    }),
    () => use,
    (handle) =>
      io(writerPath, async () => {
        try {
          await handle.close();
        } finally {
          await remove(writerPath);
        }
      }),
  );
};

/** Prepare questions against the same locked baseline used by generation. */
export const prepareGeneratedDecisions = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  ast: Ast,
  directory: string,
) =>
  Effect.gen(function* () {
    const after = yield* dialect.toDatabaseSchema(ast, "after");
    return yield* withMigrationDirectoryLock(
      directory,
      true,
      Effect.gen(function* () {
        const baseline = yield* readBaseline(directory, dialect.name);
        return yield* prepareMigrationDecisions(baseline.database, after);
      }),
    );
  });

/** Read-only comparison against the saved migration baseline; never creates output. */
export const compareGeneratedSchema = <Ast, Plan, E extends Error, R>(
  dialect: Dialect<Ast, Plan, E, R>,
  ast: Ast,
  directory: string,
) =>
  Effect.gen(function* () {
    const after = yield* dialect.toDatabaseSchema(ast, "after");
    const baseline = yield* readBaseline(directory, dialect.name);
    const diff = yield* diffDatabases(baseline.database, after);
    return { after, before: baseline.database, diff };
  });
