import { mkdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import type { Effect } from "effect";

import type { resolveConfig } from "./config.ts";
import { writeNew } from "./generate.ts";
import { configUpdate, saveConfigUpdate } from "./init-config.ts";
import { schemaFiles } from "./schema-files.ts";

const inspect = (path: string) =>
  stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

type Settings = Effect.Success<ReturnType<typeof resolveConfig>>;
export const planSetup = async (
  selected: Settings,
  options: Parameters<typeof resolveConfig>[0],
  cwd: string,
  configPath: string,
  answers: {
    dialect: string | undefined;
    driver: string | undefined;
    migrations: string;
    schema: string;
  },
) => {
  const { dialect, driver, migrations, schema } = answers;
  const { config, directory, source } = selected;
  if (schema === "-") {
    throw new Error("Choose a filesystem path for the schema.");
  }
  const schemaPath = resolve(directory, schema);
  const migrationsPath = resolve(directory, migrations);
  const schemaEntry = await inspect(schemaPath);
  const schemaDirectory = schemaEntry?.isDirectory() ?? (schema.endsWith(sep) || !extname(schema));
  if (schemaEntry && !schemaEntry.isDirectory() && !schemaEntry.isFile()) {
    throw new Error(`Expected a schema file or directory at ${schemaPath}`);
  }
  const starter = schemaDirectory ? join(schemaPath, "schema.uncut.sql") : schemaPath;
  const migrationEntry = await inspect(migrationsPath);
  if (migrationEntry && !migrationEntry.isDirectory()) {
    throw new Error(`Expected a migrations directory at ${migrationsPath}`);
  }
  if (
    starter === migrationsPath ||
    migrationsPath.startsWith(starter + sep) ||
    (!source && configPath.startsWith(starter + sep)) ||
    [starter, migrationsPath].some(
      (path) => path === configPath || path.startsWith(configPath + sep),
    )
  ) {
    throw new Error("Choose distinct paths for config, schema files and migrations.");
  }
  const needsStarter = !schemaEntry || (schemaDirectory && !(await schemaFiles(schemaPath)).length);
  const pluginPath = (flag: string | undefined, answer: string | undefined) => {
    if (!flag?.startsWith(".") || directory === cwd) {
      return answer;
    }
    const path = relative(directory, resolve(cwd, flag));
    return path.startsWith(".." + sep) || path === ".." ? path : "./" + path;
  };
  const savedPath = (previous: string | undefined, path: string) =>
    previous && resolve(directory, previous) === path ? previous : relative(directory, path) || ".";
  const fields = {
    dialect: pluginPath(options.dialect, dialect),
    driver: pluginPath(options.driver, driver),
    migrations: savedPath(config.migrations, migrationsPath),
    schema: savedPath(config.schema, schemaPath),
  };
  const changes = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => value !== undefined && config[key as keyof typeof fields] !== value,
    ),
  );
  const updated = Object.keys(changes).length ? await configUpdate(source, changes) : undefined;
  return {
    configPath,
    migrationsPath,
    schemaPath,
    source,
    starter: needsStarter ? starter : undefined,
    updated,
  };
};

export const writeSetup = async ({
  configPath,
  migrationsPath,
  source,
  starter,
  updated,
}: Awaited<ReturnType<typeof planSetup>>) => {
  if (starter) {
    await mkdir(dirname(starter), { recursive: true });
    await writeNew(starter, "");
  }
  await mkdir(migrationsPath, { recursive: true });
  if (updated !== undefined) {
    if (source) {
      await saveConfigUpdate(source, updated);
    } else {
      await mkdir(dirname(configPath), { recursive: true });
      await writeNew(configPath, updated);
    }
  }
};
