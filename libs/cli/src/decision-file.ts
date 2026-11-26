import { link, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { Effect } from "effect";

import { mergeMigrationDecisions } from "@uncutsql/core";
import type { MigrationDecisions } from "@uncutsql/core";

import type { DecisionWriterFlag } from "./config.ts";
import { InputError } from "./schema-input.ts";

export const decisionDocument = async (document: MigrationDecisions, output?: string) => {
  const directory = await realpath(output === undefined ? process.cwd() : dirname(resolve(output)));
  const schemaPath = "node_modules/@uncutsql/cli/schemas/decisions.schema.json";
  let root = directory;
  let schema = resolve(process.cwd(), schemaPath);
  // Keep the node_modules path instead of resolving the package's symlink.
  while (true) {
    const candidate = join(root, schemaPath);
    try {
      if ((await stat(candidate)).isFile()) {
        schema = candidate;
        break;
      }
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
        throw cause;
      }
    }
    const parent = dirname(root);
    if (parent === root) {
      break;
    }
    root = parent;
  }
  const path = relative(directory, schema).split(sep).join("/");
  return { $schema: path.startsWith(".") ? path : `./${path}`, ...document };
};

const hasCode = (cause: unknown, code: string) =>
  cause instanceof Error && "code" in cause && cause.code === code;

export const readDecisions = (selected: { decisions: string; decisionsRequired: boolean }) =>
  Effect.tryPromise({
    catch: (cause) =>
      new InputError({
        message: `Cannot read decisions ${selected.decisions}: ${String(cause)}`,
      }),
    try: async () => {
      let source: string;
      try {
        source = await readFile(selected.decisions, "utf8");
      } catch (cause) {
        if (!selected.decisionsRequired && hasCode(cause, "ENOENT")) {
          return undefined;
        }
        throw cause;
      }
      return JSON.parse(source);
    },
  });

export const writeDecisions = (
  fresh: MigrationDecisions,
  path: string,
  flag: DecisionWriterFlag,
) => {
  const io = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      catch: (cause) =>
        new InputError({
          message: `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      try: operation,
    });
  const stage = join(dirname(path), `.${basename(path)}.tmp`);
  return Effect.acquireUseRelease(
    io(async () => ({ handle: await open(stage, "wx", 0o600), published: false })),
    (writer) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { handle } = writer;
          let document = fresh;
          if (flag === "--merge-decisions") {
            const previous = yield* io(async () => {
              try {
                return JSON.parse(await readFile(path, "utf8")) as unknown;
              } catch (cause) {
                if (hasCode(cause, "ENOENT")) {
                  return undefined;
                }
                throw cause;
              }
            });
            if (previous !== undefined) {
              document = yield* mergeMigrationDecisions(fresh, previous).pipe(
                Effect.mapError(
                  (cause) => new InputError({ message: `${path}: ${cause.message}` }),
                ),
              );
            }
          }
          yield* io(async () => {
            const mode =
              flag === "--write-decisions"
                ? undefined
                : await stat(path).catch((cause: unknown) => {
                    if (hasCode(cause, "ENOENT")) {
                      return undefined;
                    }
                    throw cause;
                  });
            await handle.chmod(mode ? mode.mode & 0o777 : 0o666 & ~process.umask());
            await handle.writeFile(
              JSON.stringify(await decisionDocument(document, path), null, 2) + "\n",
            );
            if (flag === "--write-decisions") {
              try {
                await link(stage, path);
              } catch (cause) {
                if (hasCode(cause, "EEXIST")) {
                  throw new Error(
                    "Decision file already exists. Replace --write-decisions with --merge-decisions to keep applicable choices or --rewrite-decisions to reset every choice.",
                  );
                }
                throw cause;
              }
            } else {
              await rename(stage, path);
              writer.published = true;
            }
          });
          const renameHint = document.decisions.some(
            (item) => item.column === undefined && item.candidates.length,
          )
            ? " After choosing a table rename, run --merge-decisions with the same path to review its columns."
            : "";
          return `Wrote ${path}. Review pending resolutions.${renameHint} When all choices are complete, rerun without ${flag} (use --decisions with this path if it differs from the configured/default file).\n`;
        }),
      ),
    ({ handle, published }) =>
      io(async () => {
        try {
          await handle.close();
        } finally {
          // A successful rename releases the staging path for the next writer.
          if (!published) {
            await unlink(stage);
          }
        }
      }),
  );
};
