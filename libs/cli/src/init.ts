import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { confirm, isCancel, log, select, text } from "@clack/prompts";
import { Effect } from "effect";

import { discoverInitConfigs, resolveConfig } from "./config.ts";
import { writeNew } from "./generate.ts";
import { configUpdate, saveConfigUpdate } from "./init-config.ts";
import officialPlugins from "./official-plugins.json" with { type: "json" };
import { schemaFiles } from "./schema-files.ts";
import { interactiveTerminal } from "./terminal.ts";

const inspect = (path: string) =>
  stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

export const initProject = (options: Parameters<typeof resolveConfig>[0], cwd: string) =>
  Effect.tryPromise({
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    try: async () => {
      const terminal = interactiveTerminal()
        ? undefined
        : createInterface({ input: process.stdin, output: process.stderr });
      terminal?.on("SIGINT", () => terminal.close());
      const lines = terminal?.[Symbol.asyncIterator]();
      const ask = async (label: string, fallback = "") => {
        if (!lines) {
          const answer = await text({
            defaultValue: fallback,
            message: label,
            output: process.stderr,
            placeholder: fallback,
            validate: (value) =>
              value?.trim() || fallback ? undefined : "Enter a module name or path.",
          });
          if (isCancel(answer)) {
            throw new Error("Initialization cancelled.");
          }
          return answer.trim() || fallback;
        }
        process.stderr.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
        const line = await lines.next();
        if (line.done) {
          throw new Error("Initialization cancelled.");
        }
        return line.value.trim() || fallback;
      };
      const choose = async (label: string, values: string[], isConfig = false) => {
        const customLabel = isConfig ? "Custom filename…" : "Custom module…";
        const question = isConfig
          ? "Choose a config file"
          : `Choose a ${label.toLowerCase()} module`;
        if (!lines) {
          const choice = await select({
            message: question,
            options: [
              ...values.map((name, index) => ({ label: name, value: index })),
              { label: customLabel, value: -1 },
              ...(isConfig ? [] : [{ label: "Configure later", value: -2 }]),
            ],
            output: process.stderr,
          });
          if (isCancel(choice)) {
            throw new Error("Initialization cancelled.");
          }
          if (choice === -1) {
            return ask(
              isConfig
                ? "Custom config filename"
                : `Custom ${label.toLowerCase()} module name or path`,
            );
          }
          return values[choice];
        }
        process.stderr.write(`${question}\n`);
        values.forEach((name, index) => process.stderr.write(`  ${index + 1}) ${name}\n`));
        while (true) {
          const answer = isConfig
            ? await ask("Choose a number or enter a custom filename", "1")
            : await ask("Choose a number, type a custom module, or press Enter to skip");
          if (!/^\d+$/.test(answer)) {
            return answer || undefined;
          }
          const choice = values[Number(answer) - 1];
          if (choice) {
            return choice;
          }
          process.stderr.write("Enter a listed number or a custom value.\n");
        }
      };
      let step = 0;
      const showStep = (label: string) => process.stderr.write(`\n${++step}/6  ${label}\n`);
      const preset = (
        key: "config" | "dialect" | "driver" | "schema" | "migrations",
        value?: string,
      ) => {
        if (value !== undefined) {
          const from = options[key] === undefined ? "config" : `--${key}`;
          if (lines) {
            process.stderr.write(`Using ${value} (already set in ${from})\n`);
          } else {
            log.step(`${value}\nAlready set in ${from}`, { output: process.stderr });
          }
        }
        return value;
      };
      try {
        showStep("Config file");
        let filename = preset("config", options.config);
        if (!filename) {
          const configs = await discoverInitConfigs(cwd);
          filename = configs.length
            ? await choose("Config", configs, true)
            : await ask("Config filename", "uncutsql.config.json");
        }
        const selected = await Effect.runPromise(
          resolveConfig(filename ? { ...options, config: filename } : options, cwd, true),
        );
        const { config, directory, source } = selected;
        const configPath = source?.path ?? resolve(cwd, filename || "uncutsql.config.json");
        if (!source && (!configPath.endsWith(".json") || basename(configPath) === "package.json")) {
          throw new Error("Choose a standalone .json file for the new configuration.");
        }
        showStep("Dialect");
        const dialect =
          preset("dialect", selected.dialect?.specifier) ??
          (await choose(
            "Dialect",
            officialPlugins.map((plugin) => plugin.dialect),
          ));
        showStep("Driver");
        const driver =
          preset("driver", selected.driver?.specifier) ??
          (await choose(
            "Driver",
            officialPlugins.find((plugin) => plugin.dialect === dialect)?.drivers ?? [
              ...new Set(officialPlugins.flatMap((plugin) => plugin.drivers)),
            ],
          ));
        showStep("Schema");
        const schema =
          preset("schema", selected.schema) ??
          (await ask("Schema file or directory", "schema.uncut.sql"));
        showStep("Migrations");
        const migrations =
          preset("migrations", selected.migrations) ??
          (await ask("Migrations directory", "migrations"));

        if (schema === "-") {
          throw new Error("Choose a filesystem path for the schema.");
        }
        const schemaPath = resolve(directory, schema);
        const migrationsPath = resolve(directory, migrations);
        const schemaEntry = await inspect(schemaPath);
        const schemaDirectory =
          schemaEntry?.isDirectory() ?? (schema.endsWith(sep) || !extname(schema));
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
        const needsStarter =
          !schemaEntry || (schemaDirectory && !(await schemaFiles(schemaPath)).length);
        const pluginPath = (flag: string | undefined, answer: string | undefined) => {
          if (!flag?.startsWith(".") || directory === cwd) {
            return answer;
          }
          const path = relative(directory, resolve(cwd, flag));
          return path.startsWith(".." + sep) || path === ".." ? path : "./" + path;
        };
        const savedPath = (previous: string | undefined, path: string) =>
          previous && resolve(directory, previous) === path
            ? previous
            : relative(directory, path) || ".";
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
        const updated = Object.keys(changes).length
          ? await configUpdate(source, changes)
          : undefined;
        showStep("Confirm setup");
        process.stderr.write(
          `${source ? (updated === undefined ? "Reuse" : "Update") : "Create"} ${configPath}\n${needsStarter ? "Create empty schema" : "Use existing schema"}: ${needsStarter ? starter : schemaPath}\nMigrations directory: ${migrationsPath}\n`,
        );
        const proceed = lines
          ? /^(y|yes)$/i.test(await ask("Initialize project? (y/n)", "N"))
          : await confirm({
              initialValue: false,
              message: "Initialize project?",
              output: process.stderr,
            });
        if (proceed !== true) {
          return "Initialization cancelled.\n";
        }
        if (needsStarter) {
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
        const configHint = filename
          ? `Use --config ${JSON.stringify(filename)} with future commands.\n`
          : "";
        return `Project initialized.\n${configHint}`;
      } finally {
        terminal?.close();
      }
    },
  });
