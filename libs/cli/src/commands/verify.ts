import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { verifyGenerated } from "../apply.ts";
import { resolveConfig, UsageError } from "../config.ts";
import { outputDirectory, root } from "./shared.ts";

export const verify = Command.make("verify", { outputDirectory }, ({ outputDirectory }) =>
  Effect.gen(function* () {
    const config = yield* resolveConfig(yield* root, process.cwd());
    const directory = outputDirectory ?? config.migrations ?? "migrations";
    if (directory.startsWith("-")) {
      return yield* new UsageError({ message: "verify accepts an optional migration directory." });
    }
    const count = yield* verifyGenerated(directory);
    yield* Console.log(`Verified ${count} migration(s).`);
  }),
).pipe(
  Command.withDescription(
    "Verify the complete migration chain and lock without opening a database.",
  ),
  Command.withExamples([{ command: "uncutsql verify migrations" }]),
);
