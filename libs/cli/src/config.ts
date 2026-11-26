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
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}
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

export const parseOptions = (args: readonly string[]) =>
  Effect.try({
    catch: (cause) =>
      new UsageError({ message: cause instanceof Error ? cause.message : String(cause) }),
    try: () => {
      // Keep the legacy command lookup until every command is registered with Effect.
      // Canonical flag tokens preserve separate decision-writer paths and leave operands after -- literal.
      const flagTokens: string[] = [];
      let trailing: readonly string[] = [];
      const positional: string[] = [];
      const options: {
        config?: string;
        decisions?: string;
        decisionWriter?: { flag: DecisionWriterFlag; path: string | undefined };
        dialect?: string;
        driver?: string;
        interactive?: boolean;
        migrations?: string;
        schema?: string;
        yes?: boolean;
      } = {};
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === "--") {
          trailing = args.slice(index + 1);
          break;
        }
        const [name, ...inline] = arg.split("=");
        if (name === "--yes") {
          if (inline.length || options.yes) {
            throw new Error("--yes takes no value and may appear only once");
          }
          flagTokens.push("--yes=true");
          options.yes = true;
          continue;
        }
        if (name === "--interactive") {
          if (inline.length) {
            throw new Error("--interactive takes no value");
          }
          if (options.interactive) {
            throw new Error("--interactive was specified more than once");
          }
          flagTokens.push("--interactive=true");
          options.interactive = true;
          continue;
        }
        if (
          name === "--write-decisions" ||
          name === "--rewrite-decisions" ||
          name === "--merge-decisions"
        ) {
          if (options.decisionWriter) {
            throw new Error(
              `Choose only one decision-file option. Received ${options.decisionWriter.flag} and ${name}.`,
            );
          }
          const next = args[index + 1];
          const path = inline.length
            ? inline.join("=")
            : next !== undefined && !next.startsWith("--")
              ? args[++index]
              : undefined;
          if (path === "" || path?.startsWith("--")) {
            throw new Error(`${name} requires a nonempty path when supplied`);
          }
          flagTokens.push(path === undefined ? name : `${name}=${path}`);
          options.decisionWriter = { flag: name, path };
          continue;
        }
        if (
          name !== "--schema" &&
          name !== "--migrations" &&
          name !== "--config" &&
          name !== "--dialect" &&
          name !== "--driver" &&
          name !== "--decisions"
        ) {
          positional.push(arg);
          continue;
        }
        const value = inline.length ? inline.join("=") : args[++index];
        if (!value || value.startsWith("--")) {
          throw new Error(`${name} requires a value`);
        }
        const key = name.slice(2) as Exclude<
          keyof typeof options,
          "decisionWriter" | "interactive" | "yes"
        >;
        if (options[key] !== undefined) {
          throw new Error(`${name} was specified more than once`);
        }
        flagTokens.push(`${name}=${value}`);
        options[key] = value;
      }
      const operands = positional.length ? trailing : trailing.slice(1);
      const commandArgs = [...flagTokens, ...positional.slice(1)];
      if (operands.length) {
        commandArgs.push("--", ...operands);
      }
      return { args: [...positional, ...trailing], commandArgs, options };
    },
  });

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
