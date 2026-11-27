import { Effect } from "effect";
import { Command } from "effect/cli";

import { UsageError } from "../config.ts";
import { reportCommand } from "../prompts/conversation.ts";
import { initProject } from "../prompts/init.ts";
import { root } from "./shared.ts";

export const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const flags = yield* root;
    if (flags.schema === "-") {
      return yield* new UsageError({ message: "init requires a filesystem schema path." });
    }
    yield* reportCommand("Initialize project", initProject(flags, process.cwd()));
  }),
).pipe(
  Command.withDescription("Set up schema and migration paths and configure project plugins."),
  Command.withExamples([{ command: "uncutsql init --config project.json" }]),
);
