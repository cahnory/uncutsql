import type { Option } from "@clack/prompts";
import { select } from "@clack/prompts";
import { Effect } from "effect";

import { mergeMigrationDecisions, tableKey } from "@uncutsql/core";
import type { MigrationDecision, MigrationDecisions } from "@uncutsql/core";

import { style } from "../terminal.ts";
import { promptIO, withConversation } from "./conversation.ts";
import type { Conversation } from "./conversation.ts";

const chooseResolution = async (
  item: MigrationDecision,
  candidates: readonly string[],
  supportsDropGuards: boolean,
  ui: Conversation,
) => {
  const choices: Option<MigrationDecision["resolution"]>[] = [];
  if (supportsDropGuards) {
    choices.push({
      label:
        item.column === undefined
          ? "Drop only if the table is empty"
          : "Drop only if every value is NULL",
      value: { action: "drop_if_empty" },
    });
  }
  choices.push({
    label: style("red", "Drop and discard any data"),
    value: { action: "drop" },
  });
  for (const target of candidates) {
    choices.push({
      label: `Rename to ${JSON.stringify(target)}`,
      value: { action: "rename", target },
    });
  }

  if (!ui.line) {
    const cancel = { action: "cancel" } as const;
    const selected = ui.answer(
      await select<MigrationDecision["resolution"] | typeof cancel>({
        initialValue: supportsDropGuards ? choices[0]!.value : cancel,
        message: item.question,
        options: [...choices, { label: "Cancel generation", value: cancel }],
        output: ui.output,
      }),
    );
    if (selected.action === "cancel") {
      throw new Error("Generation cancelled.");
    }
    return selected;
  }
  ui.output.write(`\n${item.question}\n`);
  choices.forEach(({ label }, index) => ui.output.write(`  ${index + 1}) ${label}\n`));
  while (true) {
    const answer = ui.answer(await ui.line(`Choose 1-${choices.length} (q to cancel): `));
    if (answer.toLowerCase() === "q") {
      throw new Error("Generation cancelled.");
    }
    const choice = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
    if (choice) {
      return choice.value;
    }
    ui.output.write("Enter one of the listed numbers.\n");
  }
};

export const promptDecisions = (fresh: MigrationDecisions, supportsDropGuards: boolean) =>
  !fresh.decisions.length
    ? Effect.succeed(fresh)
    : withConversation("Generation cancelled.", (ui) =>
        Effect.gen(function* () {
          const claimed = new Set<string>();
          let review = fresh;
          while (review.decisions.some((item) => item.resolution.action === "pending")) {
            const decisions: MigrationDecision[] = [];
            for (const item of review.decisions) {
              if (item.resolution.action !== "pending") {
                decisions.push(item);
                continue;
              }
              const targetKey = (name: string) =>
                item.column === undefined
                  ? JSON.stringify([tableKey({ ...item.table, name })])
                  : JSON.stringify([tableKey(item.table), name]);
              const candidates = item.candidates.filter((name) => !claimed.has(targetKey(name)));
              const resolution = yield* promptIO(() =>
                chooseResolution(item, candidates, supportsDropGuards, ui),
              );
              if (resolution.action === "rename") {
                claimed.add(targetKey(resolution.target));
              }
              decisions.push({ ...item, resolution });
            }
            review = yield* mergeMigrationDecisions(fresh, { ...review, decisions });
          }
          return review;
        }),
      );
