import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Data, Effect } from "effect";

export interface UncutConfig {
  /** JSON Schema location for editor tooling. */
  readonly $schema?: string;
  /** Review decisions file, relative to this config. */
  readonly decisions?: string;
  readonly dialect?: string;
  readonly driver?: string;
  /** Directory containing numbered migrations and the lock, relative to this config. */
  readonly migrations?: string;
  /** Schema file or directory of *.uncut.sql files, relative to this config. */
  readonly schema?: string;
}
export const defineConfig = <T extends UncutConfig>(config: T): T => config;
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly message: string;
}> {}
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
  readonly usage?: string | undefined;
}> {}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validate = (value: unknown): UncutConfig => {
  if (!record(value)) {
    throw new Error("Expected a configuration object");
  }
  for (const key of Object.keys(value)) {
    if (!["$schema", "dialect", "driver", "schema", "migrations", "decisions"].includes(key)) {
      throw new Error(`Unknown configuration option: ${key}`);
    }
    if (typeof value[key] !== "string" || !value[key].trim()) {
      throw new Error(`${key} must be a nonempty string`);
    }
  }
  return value as UncutConfig;
};

export type DecisionWriterFlag = "--write-decisions" | "--rewrite-decisions" | "--merge-decisions";

export interface PluginSelection {
  readonly directory: string;
  readonly specifier: string;
}
export interface ConfigSource {
  manifest: boolean;
  path: string;
  text: string;
}

const configNames = [
  ".uncutsqlrc.json",
  "uncutsql.config.json",
  "uncutsql.config.js",
  "uncutsql.config.cjs",
  "uncutsql.config.mjs",
  "uncutsql.config.ts",
  "uncutsql.config.cts",
  "uncutsql.config.mts",
];

export async function discoverInitConfigs(cwd: string) {
  const entries = await readdir(cwd, { withFileTypes: true });
  const files = new Set(
    entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name),
  );
  const found = configNames.filter((name) => files.has(name));
  for (const name of [...files].sort()) {
    if (!name.endsWith(".json") || configNames.includes(name)) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(await readFile(resolve(cwd, name), "utf8"));
      if (name === "package.json") {
        if (record(value) && "uncutsql" in value) {
          found.unshift(name);
        }
      } else if (
        record(value) &&
        ["dialect", "driver", "schema", "migrations", "decisions"].some((key) => key in value)
      ) {
        validate(value);
        found.push(name);
      }
    } catch {
      // Unrelated JSON files need not be readable project configurations.
    }
  }
  return found;
}

export const resolveConfig = (
  options: {
    config?: string | undefined;
    decisions?: string | undefined;
    dialect?: string | undefined;
    driver?: string | undefined;
    migrations?: string | undefined;
    schema?: string | undefined;
  },
  cwd: string,
  allowNewConfig = false,
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ConfigurationError({
        message: `Configuration: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    try: async () => {
      const read = async (path: string) => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if (record(error) && error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      };
      const load = async (path: string, text: string) =>
        path.endsWith(".json")
          ? validate(JSON.parse(text))
          : validate((await import(pathToFileURL(path).href)).default);
      let config: UncutConfig = {};
      let directory = cwd;
      let source: ConfigSource | undefined;
      if (options.config !== undefined) {
        const path = resolve(cwd, options.config);
        const text = await read(path);
        if (text === undefined) {
          if (!allowNewConfig) {
            throw new Error(`Configuration file not found: ${path}`);
          }
        } else {
          const manifest = basename(path) === "package.json";
          source = { manifest, path, text };
          if (manifest) {
            const pkg = JSON.parse(text);
            config = validate(allowNewConfig && pkg.uncutsql === undefined ? {} : pkg.uncutsql);
          } else {
            config = await load(path, text);
          }
        }
        directory = dirname(path);
      } else {
        // Match the previous project's precedence: package.json before config files.
        const pkgText = await read(resolve(cwd, "package.json"));
        const pkg: unknown = pkgText === undefined ? {} : JSON.parse(pkgText);
        if (record(pkg) && "uncutsql" in pkg) {
          source = { manifest: true, path: resolve(cwd, "package.json"), text: pkgText! };
          config = validate(pkg.uncutsql);
        } else {
          for (const filename of configNames) {
            const path = resolve(cwd, filename);
            const text = await read(path);
            if (text === undefined) {
              continue;
            }
            source = { manifest: false, path, text };
            config = await load(path, text);
            break;
          }
        }
      }
      const select = (key: "dialect" | "driver"): PluginSelection | undefined => {
        const flag = options[key];
        if (flag !== undefined) {
          return { directory: cwd, specifier: flag };
        }
        const specifier = config[key];
        return specifier === undefined ? undefined : { directory, specifier };
      };
      return {
        config,
        configured: source !== undefined,
        decisions:
          options.decisions === undefined
            ? resolve(directory, config.decisions ?? "uncutsql.decisions.json")
            : resolve(cwd, options.decisions),
        decisionsRequired: options.decisions !== undefined || config.decisions !== undefined,
        dialect: select("dialect"),
        directory,
        driver: select("driver"),
        migrations:
          options.migrations === undefined
            ? config.migrations && resolve(directory, config.migrations)
            : resolve(cwd, options.migrations),
        schema:
          options.schema === undefined
            ? config.schema && resolve(directory, config.schema)
            : options.schema === "-"
              ? "-"
              : resolve(cwd, options.schema),
        source,
      };
    },
  });
