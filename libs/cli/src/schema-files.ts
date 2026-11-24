import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function schemaFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) {
    return [path];
  }
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".uncut.sql"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}
