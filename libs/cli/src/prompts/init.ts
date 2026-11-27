import { basename, resolve } from "node:path";

import { group, log, note, select, text } from "@clack/prompts";
import { Effect } from "effect";

import { discoverInitConfigs, resolveConfig } from "../config.ts";
import { planSetup, writeSetup } from "../init.ts";
import officialPlugins from "../official-plugins.json" with { type: "json" };
import { promptIO, withConversation } from "./conversation.ts";

export const initProject = (options: Parameters<typeof resolveConfig>[0], cwd: string) =>
  withConversation("Initialization cancelled.", (ui) =>
    Effect.gen(function* () {
      let step = 0;
      const numbered = (message: string) => `${++step}/6 ${message}`;
      const ask = async (label: string, fallback = "") => {
        if (ui.line) {
          return (
            ui.answer(await ui.line(`${label}${fallback ? ` [${fallback}]` : ""}: `)) || fallback
          );
        }
        const answer = ui.answer(
          await text({
            defaultValue: fallback,
            message: label,
            output: ui.output,
            placeholder: fallback,
            validate: (value) => (value?.trim() || fallback ? undefined : "Enter a name or path."),
          }),
        );
        return answer.trim() || fallback;
      };
      const choose = async (label: string, values: string[], isConfig = false) => {
        const question = numbered(
          isConfig ? "Choose a config file" : `Choose a ${label.toLowerCase()} module`,
        );
        if (!ui.line) {
          const custom = { kind: "custom" } as const;
          const later = { kind: "later" } as const;
          const choice = ui.answer(
            await select<string | typeof custom | typeof later>({
              message: question,
              options: [
                ...values.map((value) => ({ label: value, value })),
                { label: isConfig ? "Custom filename…" : "Custom module…", value: custom },
                ...(isConfig ? [] : [{ label: "Configure later", value: later }]),
              ],
              output: ui.output,
            }),
          );
          if (typeof choice === "string") {
            return choice;
          }
          return choice.kind === "later"
            ? undefined
            : ask(
                isConfig
                  ? "Custom config filename"
                  : `Custom ${label.toLowerCase()} module name or path`,
              );
        }
        ui.output.write(`${question}\n`);
        values.forEach((name, index) => ui.output.write(`  ${index + 1}) ${name}\n`));
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
          ui.output.write("Enter a listed number or a custom value.\n");
        }
      };
      const preset = (key: keyof typeof options, value?: string) => {
        if (value !== undefined) {
          const from = options[key] === undefined ? "config" : `--${key}`;
          const message = numbered(`Use ${key} ${value} (already set in ${from})`);
          if (ui.line) {
            ui.output.write(message + "\n");
          } else {
            log.step(message, { output: ui.output });
          }
        }
        return value;
      };
      const filename =
        preset("config", options.config) ??
        (yield* promptIO(async () => {
          const configs = await discoverInitConfigs(cwd);
          return configs.length
            ? choose("Config", configs, true)
            : ask(numbered("Config filename"), "uncutsql.config.json");
        }));
      const selected = yield* resolveConfig({ ...options, config: filename }, cwd, true);
      const configPath = selected.source?.path ?? resolve(cwd, filename || "uncutsql.config.json");
      if (
        !selected.source &&
        (!configPath.endsWith(".json") || basename(configPath) === "package.json")
      ) {
        return yield* Effect.fail(
          new Error("Choose a standalone .json file for the new configuration."),
        );
      }
      const answers = yield* promptIO(() =>
        group<{
          dialect: string | undefined;
          driver: string | undefined;
          migrations: string;
          schema: string;
        }>({
          dialect: async () => {
            return (
              preset("dialect", selected.dialect?.specifier) ??
              choose(
                "Dialect",
                officialPlugins.map((plugin) => plugin.dialect),
              )
            );
          },
          driver: async ({ results }) => {
            return (
              preset("driver", selected.driver?.specifier) ??
              choose(
                "Driver",
                officialPlugins.find((plugin) => plugin.dialect === results.dialect)?.drivers ?? [
                  ...new Set(officialPlugins.flatMap((plugin) => plugin.drivers)),
                ],
              )
            );
          },
          schema: async () => {
            return (
              preset("schema", selected.schema) ??
              ask(numbered("Schema file or directory"), "schema.uncut.sql")
            );
          },

          // Clack asks in insertion order. Keep migrations after the schema.
          migrations: async () => {
            return (
              preset("migrations", selected.migrations) ??
              ask(numbered("Migrations directory"), "migrations")
            );
          },
        }),
      );
      const plan = yield* promptIO(() => planSetup(selected, options, cwd, configPath, answers));
      const preview = [
        `${plan.source ? (plan.updated === undefined ? "Reuse" : "Update") : "Create"} ${plan.configPath}`,
        `${plan.starter ? "Create empty schema" : "Use existing schema"}: ${plan.starter ?? plan.schemaPath}`,
        `Migrations directory: ${plan.migrationsPath}`,
      ].join("\n");
      if (ui.line) {
        ui.output.write(preview + "\n");
      } else {
        note(preview, "Setup preview", { output: ui.output });
      }
      if (!(yield* promptIO(() => ui.confirm(numbered("Initialize project?"), false)))) {
        return "Initialization cancelled.\n";
      }
      yield* promptIO(() => writeSetup(plan));
      return (
        "Project initialized.\n" +
        (filename ? `Use --config ${JSON.stringify(filename)} with future commands.\n` : "")
      );
    }),
  );
