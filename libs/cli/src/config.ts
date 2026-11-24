import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";

export interface UncutConfig {
  /** Schema file or directory of *.uncut.sql files, relative to this config. */
  readonly schema?: string;
  /** Directory containing numbered migrations and the lock, relative to this config. */
  readonly migrations?: string;
  readonly dialect?: string;
  readonly driver?: string;
}
export const defineConfig = <T extends UncutConfig>(config: T): T => config;
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly message: string;
}> {}
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validate = (value: unknown): UncutConfig => {
  if (!record(value)) throw new Error("Expected a configuration object");
  for (const key of Object.keys(value)) {
    if (key !== "dialect" && key !== "driver" && key !== "schema" && key !== "migrations")
      throw new Error(`Unknown configuration option: ${key}`);
    if (typeof value[key] !== "string" || !value[key].trim())
      throw new Error(`${key} must be a nonempty string`);
  }
  return value as UncutConfig;
};

export const parseOptions = (args: readonly string[]) =>
  Effect.try({
    try: () => {
      const positional: string[] = [];
      const options: {
        config?: string;
        dialect?: string;
        driver?: string;
        decisions?: string;
        writeDecisions?: string;
      } = {};
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === "--") {
          positional.push(...args.slice(index + 1));
          break;
        }
        const [name, ...inline] = arg.split("=");
        if (
          name !== "--config" &&
          name !== "--dialect" &&
          name !== "--driver" &&
          name !== "--decisions" &&
          name !== "--write-decisions"
        ) {
          positional.push(arg);
          continue;
        }
        const value = inline.length ? inline.join("=") : args[++index];
        if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
        const key = (
          name === "--write-decisions" ? "writeDecisions" : name.slice(2)
        ) as keyof typeof options;
        if (options[key] !== undefined) throw new Error(`${name} was specified more than once`);
        options[key] = value;
      }
      return { args: positional, options };
    },
    catch: (cause) =>
      new UsageError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

export interface PluginSelection {
  readonly specifier: string;
  readonly directory: string;
}
export const resolveConfig = (
  options: { config?: string; dialect?: string; driver?: string },
  cwd: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const read = async (path: string) => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if (record(error) && error.code === "ENOENT") return undefined;
          throw error;
        }
      };
      const load = async (path: string, text: string) =>
        path.endsWith(".json")
          ? validate(JSON.parse(text))
          : validate((await import(pathToFileURL(path).href)).default);
      let config: UncutConfig = {};
      let directory = cwd;
      if (options.config !== undefined) {
        const path = resolve(cwd, options.config);
        const text = await read(path);
        if (text === undefined) throw new Error(`Configuration file not found: ${path}`);
        config = await load(path, text);
        directory = dirname(path);
      } else {
        // Match the previous project's precedence: package.json before config files.
        const pkgText = await read(resolve(cwd, "package.json"));
        const pkg: unknown = pkgText === undefined ? {} : JSON.parse(pkgText);
        if (record(pkg) && "uncutsql" in pkg) config = validate(pkg.uncutsql);
        else
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
            if (text === undefined) continue;
            config = await load(path, text);
            break;
          }
      }
      const select = (key: "dialect" | "driver"): PluginSelection | undefined => {
        const flag = options[key];
        if (flag !== undefined) return { specifier: flag, directory: cwd };
        const specifier = config[key];
        return specifier === undefined ? undefined : { specifier, directory };
      };
      return {
        dialect: select("dialect"),
        driver: select("driver"),
        schema: config.schema && resolve(directory, config.schema),
        migrations: config.migrations && resolve(directory, config.migrations),
      };
    },
    catch: (cause) =>
      new ConfigurationError({
        message: `Configuration: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
