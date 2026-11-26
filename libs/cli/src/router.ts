import { Effect, Option } from "effect";
import { CliConfig, CliError, CliOutput, Command, CommandSpec, GlobalFlag } from "effect/cli";

import manifest from "../package.json" with { type: "json" };
import { normalizeArguments } from "./arguments.ts";
import { decisions, diff, diffAgainstLock, migration } from "./commands/comparison.ts";
import { adopt, apply, compact, down, extract, up } from "./commands/database.ts";
import { generate } from "./commands/generate.ts";
import { init } from "./commands/init.ts";
import { check, format } from "./commands/schema.ts";
import { root } from "./commands/shared.ts";
import { verify } from "./commands/verify.ts";
import { UsageError } from "./config.ts";

const registered = [
  init,
  check,
  format,
  verify,
  generate,
  diff,
  decisions,
  migration,
  apply,
  up,
  down,
  extract,
  adopt,
  compact,
] as const;
const commands = root.pipe(
  Command.withDescription(
    "With no command, compare the configured schema against the migration lock.",
  ),
  Command.withHandler((flags) => diffAgainstLock(flags)),
  Command.withSubcommands(registered),
);
const run = Command.runWith(commands, { version: manifest.version });

const flags = new Map(
  registered.flatMap((command) =>
    Option.getOrThrow(
      CommandSpec.resolve(commands, [commands.name, command.name], { builtIns: [] }),
    ).flags.map((flag) => [flag.name, flag] as const),
  ),
);

export const runCommands = (args: readonly string[]) =>
  Effect.gen(function* () {
    const input = yield* normalizeArguments(args, flags);
    let usage: string | undefined;
    yield* run(input).pipe(
      Effect.provideService(CliConfig.CliConfig, { builtIns: [GlobalFlag.Help] }),
      Effect.provideService(CliOutput.Presenter, {
        present: (event) => {
          if (event._tag === "InvalidInvocation") {
            usage = event.helpDoc.usage;
            return Effect.void;
          }
          return CliOutput.defaultPresenter.present(event);
        },
      }),
      Effect.mapError((error) => {
        if (!CliError.isCliError(error)) {
          return error;
        }
        const message =
          error._tag === "ShowHelp"
            ? error.errors.map((cause) => cause.message).join("\n")
            : error.message;
        return new UsageError({ message, usage });
      }),
    );
  });
