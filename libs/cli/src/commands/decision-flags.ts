import { Array, Effect, Option } from "effect";
import type { Command } from "effect/cli";
import { Flag } from "effect/cli";

import { UsageError } from "../config.ts";
import type { DecisionWriterFlag } from "../config.ts";

const writer = (flag: DecisionWriterFlag, description: string) =>
  Flag.String(flag.slice(2)).pipe(
    Flag.withOptionalValue(""),
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.map((path) => ({ flag, path: path || undefined }))),
  );

export const decisionFlags = {
  decisions: Flag.String("decisions").pipe(
    Flag.withDescription("Read reviewed decisions from this file."),
    Flag.withDefault(undefined),
  ),
  merge: writer("--merge-decisions", "Refresh the file and keep applicable decisions."),
  rewrite: writer("--rewrite-decisions", "Reset current decisions to pending."),
  write: writer("--write-decisions", "Create a new decision file."),
};

export const selectWriter = (input: Command.Command.Config.Infer<typeof decisionFlags>) =>
  Effect.gen(function* () {
    const writers = Array.getSomes([input.write, input.rewrite, input.merge]);
    const writer = writers[0];
    if (writers.length > 1 || (writer && input.decisions !== undefined)) {
      return yield* new UsageError({ message: "Choose only one decision-file option." });
    }
    return writer;
  });
