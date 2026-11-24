import { link, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { mergeMigrationDecisions, type MigrationDecisions } from "@uncutsql/core";
import type { DecisionWriterFlag } from "./config.ts";

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
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  const path = relative(directory, schema).split(sep).join("/");
  return { $schema: path.startsWith(".") ? path : `./${path}`, ...document };
};

const hasCode = (cause: unknown, code: string) =>
  cause instanceof Error && "code" in cause && cause.code === code;

export const writeDecisionFile = async (
  fresh: MigrationDecisions,
  path: string,
  flag: DecisionWriterFlag,
) => {
  // Writers share a staging path so a merge reads and publishes under the same lock.
  const stage = join(dirname(path), `.${basename(path)}.tmp`);
  const handle = await open(stage, "wx", 0o600);
  let published = false;
  try {
    let document = fresh;
    if (flag === "--merge-decisions") {
      const previous = await readFile(path, "utf8").catch((cause: unknown) => {
        if (hasCode(cause, "ENOENT")) return undefined;
        throw cause;
      });
      if (previous !== undefined)
        document = await Effect.runPromise(mergeMigrationDecisions(fresh, JSON.parse(previous)));
    }
    const mode =
      flag === "--write-decisions"
        ? undefined
        : await stat(path).catch((cause: unknown) => {
            if (hasCode(cause, "ENOENT")) return undefined;
            throw cause;
          });
    await handle.chmod(mode ? mode.mode & 0o777 : 0o666 & ~process.umask());
    await handle.writeFile(JSON.stringify(await decisionDocument(document, path), null, 2) + "\n");
    if (flag === "--write-decisions") {
      try {
        await link(stage, path);
      } catch (cause) {
        if (hasCode(cause, "EEXIST"))
          throw new Error(
            "Decision file already exists. Replace --write-decisions with --merge-decisions to keep applicable choices or --rewrite-decisions to reset every choice.",
          );
        throw cause;
      }
    } else {
      await rename(stage, path);
      published = true;
    }
    return `Wrote ${path}. Review pending resolutions, then rerun without ${flag} (use --decisions with this path if it differs from the configured/default file).\n`;
  } finally {
    await handle.close();
    // A successful rename transfers ownership of the staging path to the next writer.
    if (!published) await unlink(stage);
  }
};
