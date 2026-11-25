import { createHash } from "node:crypto";
import { lstat, mkdir, open, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

import { writeNew } from "./generate.ts";
import { schemaFiles } from "./schema-files.ts";

const partFilename = (name: string) => {
  const portable =
    /^[a-zA-Z0-9_-]{1,120}$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
  const stem = portable
    ? name.toLowerCase()
    : "~" + createHash("sha256").update(name).digest("hex");
  return stem + ".uncut.sql";
};

const inspect = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });

export async function writeExtractedSchema(
  target: string,
  destination: string,
  parts: readonly { readonly name: string; readonly sql: string }[],
) {
  const entry = await inspect(destination);
  const multipart = entry?.isDirectory() ?? (!extname(destination) || destination.endsWith(sep));
  const files =
    multipart && parts.length
      ? parts.map((part) => ({ path: join(destination, partFilename(part.name)), sql: part.sql }))
      : [
          {
            path: multipart ? join(destination, "schema.uncut.sql") : destination,
            sql: parts.map((part) => part.sql).join("\n"),
          },
        ];
  const directory = dirname(files[0]!.path);
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, ".uncutsql-extract.lock");
  await mkdir(lockPath);
  const created: string[] = [];
  try {
    const existing = multipart ? await schemaFiles(resolve(destination)) : [];
    const starter = multipart ? join(destination, "schema.uncut.sql") : destination;
    const starterInfo = await inspect(starter);
    if (
      existing.some((path) => path !== resolve(starter)) ||
      (starterInfo && (!starterInfo.isFile() || starterInfo.size))
    ) {
      throw new Error(`Refusing to overwrite existing schema at ${destination}`);
    }
    if (starterInfo) {
      const source = await stat(target).catch(() => undefined);
      if (source && source.dev === starterInfo.dev && source.ino === starterInfo.ino) {
        throw new Error(`Schema destination refers to the source database: ${starter}`);
      }
    }
    // Write new parts first so a failed export preserves the empty starter from init.
    for (const file of files) {
      if (file.path !== starter || !starterInfo) {
        await writeNew(file.path, file.sql);
        created.push(file.path);
      }
    }
    if (starterInfo) {
      const contents = files.find((file) => file.path === starter)?.sql;
      if (contents === undefined) {
        await unlink(starter);
      } else {
        const handle = await open(starter, "r+");
        try {
          await handle.writeFile(contents);
        } catch (error) {
          await handle.truncate(0);
          throw error;
        } finally {
          await handle.close();
        }
      }
    }
  } catch (error) {
    await Promise.all(created.map((path) => unlink(path)));
    throw error;
  } finally {
    await rmdir(lockPath);
  }
}
