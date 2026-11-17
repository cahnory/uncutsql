import { resolve as resolveModule } from "import-meta-resolve";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";
import type { Dialect, MigrationExecutor } from "@uncutsql/core";
import type { PluginSelection } from "./config.ts";

export class PluginError extends Data.TaggedError("PluginError")<{ readonly message: string }> {}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const load = (selection: PluginSelection | undefined, kind: "dialect" | "driver") =>
  Effect.tryPromise({
    try: async () => {
      if (selection === undefined)
        throw new Error(`Select a ${kind} with --${kind} or configuration`);
      const { specifier, directory } = selection;
      const url = specifier.startsWith("file:")
        ? specifier
        : isAbsolute(specifier) || specifier.startsWith(".")
          ? pathToFileURL(resolve(directory, specifier)).href
          : resolveModule(specifier, pathToFileURL(resolve(directory, "package.json")).href);
      const module: unknown = await import(url);
      const exported = record(module)
        ? (module[kind === "dialect" ? "dialect" : "executor"] ?? module.default)
        : undefined;
      if (!record(exported))
        throw new Error(
          `Module must export ${kind === "dialect" ? "dialect" : "executor"} or a default adapter`,
        );
      const identity = kind === "dialect" ? "name" : "dialect";
      if (typeof exported[identity] !== "string" || !exported[identity].trim())
        throw new Error(`Adapter requires a nonempty ${identity}`);
      const methods =
        kind === "dialect"
          ? ["parse", "format", "toDatabaseSchema", "lowerMigration", "encodeMigration"]
          : ["apply"];
      for (const method of methods)
        if (typeof exported[method] !== "function")
          throw new Error(`Adapter is missing ${method}()`);
      return exported;
    },
    catch: (cause) =>
      new PluginError({
        message: `Cannot load ${kind}${selection ? ` ${JSON.stringify(selection.specifier)}` : ""}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

// The module boundary erases each plugin's private AST/plan types. Both are
// produced and consumed by that same validated adapter. Plugins supply their
// own Effect services before exporting these ready-to-run capabilities.
export const loadDialect = (selection: PluginSelection | undefined) =>
  Effect.map(load(selection, "dialect"), (value) => value as unknown as Dialect<unknown, unknown>);
export const loadDriver = (selection: PluginSelection | undefined) =>
  Effect.map(load(selection, "driver"), (value) => value as unknown as MigrationExecutor);
