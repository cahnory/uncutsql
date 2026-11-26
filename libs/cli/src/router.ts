import { Effect } from "effect";
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/cli";

import manifest from "../package.json" with { type: "json" };
import { generate } from "./commands/generate.ts";
import { check, format } from "./commands/schema.ts";
import { root } from "./commands/shared.ts";
import { verify } from "./commands/verify.ts";
import { UsageError } from "./config.ts";

const registered = [check, format, verify, generate] as const;
export const isRegisteredCommand = (name: string) =>
  registered.some((command) => command.name === name);
const commands = root.pipe(Command.withSubcommands(registered));
const run = Command.runWith(commands, { version: manifest.version });

export const runCommands = (args: readonly string[]) =>
  run(args).pipe(
    Effect.provideService(CliConfig.CliConfig, { builtIns: [GlobalFlag.Help] }),
    // The executable prints usage failures on stderr. The default presenter also prints help on stdout.
    Effect.provideService(CliOutput.Presenter, {
      present: (event) =>
        event._tag === "InvalidInvocation"
          ? Effect.void
          : CliOutput.defaultPresenter.present(event),
    }),
    Effect.mapError((error) =>
      CliError.isCliError(error)
        ? new UsageError({
            message:
              error._tag === "ShowHelp"
                ? error.errors.map((e) => e.message).join("\n")
                : error.message,
          })
        : error,
    ),
  );
