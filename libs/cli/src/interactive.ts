import { createInterface } from "node:readline";

import { isCancel, select } from "@clack/prompts";
import { Effect } from "effect";

import { mergeMigrationDecisions, tableKey } from "@uncutsql/core";
import type { MigrationDecision, MigrationDecisions } from "@uncutsql/core";

import { interactiveTerminal, style } from "./terminal.ts";

const chooseResolution = async (
  item: MigrationDecision,
  candidates: readonly string[],
  supportsDropGuards: boolean,
  lines: AsyncIterator<string> | undefined,
) => {
  const choices: { label: string; resolution: MigrationDecision["resolution"] }[] = [];
  if (supportsDropGuards) {
    choices.push({
      label:
        item.column === undefined
          ? "Drop only if the table is empty"
          : "Drop only if every value is NULL",
      resolution: { action: "drop_if_empty" },
    });
  }
  choices.push({
    label: style("red", "Drop and discard any data"),
    resolution: { action: "drop" },
  });
  for (const target of candidates) {
    choices.push({
      label: `Rename to ${JSON.stringify(target)}`,
      resolution: { action: "rename", target },
    });
  }

  if (!lines) {
    const cancel = -1;
    const selected = await select({
      initialValue: supportsDropGuards ? 0 : cancel,
      message: item.question,
      options: [
        ...choices.map(({ label }, value) => ({ label, value })),
        { label: "Cancel generation", value: cancel },
      ],
      output: process.stderr,
    });
    if (isCancel(selected) || selected === cancel) {
      throw new Error("Generation cancelled.");
    }
    return choices[selected]!.resolution;
  }

  process.stderr.write(`\n${item.question}\n`);
  choices.forEach(({ label }, index) => process.stderr.write(`  ${index + 1}) ${label}\n`));
  while (true) {
    process.stderr.write(`Choose 1-${choices.length} (q to cancel): `);
    const line = await lines.next();
    if (line.done || line.value.trim().toLowerCase() === "q") {
      throw new Error("Generation cancelled.");
    }
    const answer = line.value.trim();
    const choice = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
    if (choice) {
      return choice.resolution;
    }
    process.stderr.write("Enter one of the listed numbers.\n");
  }
};

export const promptDecisions = (fresh: MigrationDecisions, supportsDropGuards: boolean) =>
  Effect.tryPromise({
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    try: async () => {
      if (!fresh.decisions.length) {
        return fresh;
      }
      const terminal = interactiveTerminal()
        ? undefined
        : createInterface({ input: process.stdin, output: process.stderr });
      const lines = terminal?.[Symbol.asyncIterator]();
      terminal?.on("SIGINT", () => terminal.close());
      const claimed = new Set<string>();
      let review = fresh;
      try {
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
            const resolution = await chooseResolution(item, candidates, supportsDropGuards, lines);
            if (resolution.action === "rename") {
              claimed.add(targetKey(resolution.target));
            }
            decisions.push({ ...item, resolution });
          }
          review = await Effect.runPromise(
            mergeMigrationDecisions(fresh, { ...review, decisions }),
          );
        }
        return review;
      } finally {
        terminal?.close();
      }
    },
  });
