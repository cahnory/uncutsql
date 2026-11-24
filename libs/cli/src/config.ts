import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
      } = {};
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === "--") {
          positional.push(...args.slice(index + 1));
          break;
        }
        const [name, ...inline] = arg.split("=");
        if (name === "--interactive") {
          if (inline.length) {
            throw new Error("--interactive takes no value");
          }
          if (options.interactive) {
            throw new Error("--interactive was specified more than once");
          }
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
          "decisionWriter" | "interactive"
        >;
        if (options[key] !== undefined) {
          throw new Error(`${name} was specified more than once`);
        }
        options[key] = value;
      }
      return { args: positional, options };
    },
  });

export interface PluginSelection {
  readonly directory: string;
  readonly specifier: string;
}
export const resolveConfig = (
  options: {
    config?: string;
    decisions?: string;
    dialect?: string;
    driver?: string;
    migrations?: string;
    schema?: string;
  },
  cwd: string,
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
      let configured = false;
      if (options.config !== undefined) {
        const path = resolve(cwd, options.config);
        const text = await read(path);
        if (text === undefined) {
          throw new Error(`Configuration file not found: ${path}`);
        }
        configured = true;
        config = await load(path, text);
        directory = dirname(path);
      } else {
        // Match the previous project's precedence: package.json before config files.
        const pkgText = await read(resolve(cwd, "package.json"));
        const pkg: unknown = pkgText === undefined ? {} : JSON.parse(pkgText);
        if (record(pkg) && "uncutsql" in pkg) {
          configured = true;
          config = validate(pkg.uncutsql);
        } else {
          for (const filename of [
            ".uncutsqlrc.json",
            "uncutsql.config.json",
            "uncutsql.config.js",
            "uncutsql.config.cjs",
            "uncutsql.config.mjs",
            "uncutsql.config.ts",
            "uncutsql.config.cts",
            "uncutsql.config.mts",
          ]) {
            const path = resolve(cwd, filename);
            const text = await read(path);
            if (text === undefined) {
              continue;
            }
            configured = true;
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
        configured,
        decisions:
          options.decisions === undefined
            ? resolve(directory, config.decisions ?? "uncutsql.decisions.json")
            : resolve(cwd, options.decisions),
        decisionsRequired: options.decisions !== undefined || config.decisions !== undefined,
        dialect: select("dialect"),
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
      };
    },
  });
