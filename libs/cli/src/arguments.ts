import { parseArgs } from "node:util";

import { Effect } from "effect";
import type { CommandSpec } from "effect/cli";

import { UsageError } from "./config.ts";

// Fold separate values and move flags behind the operands so Effect can dispatch
// command-local flags supplied before the command. Keep everything after -- literal.
export const normalizeArguments = (
  args: readonly string[],
  flags: ReadonlyMap<string, CommandSpec.Flag>,
) =>
  Effect.gen(function* () {
    const options = Object.fromEntries(
      Array.from(flags, ([name, flag]) => [
        name,
        {
          type:
            flag.type._tag === "Boolean" || flag.optionalValue !== undefined
              ? ("boolean" as const)
              : ("string" as const),
        },
      ]),
    );
    const { tokens } = parseArgs({ args: [...args], options, strict: false, tokens: true });
    const operands: string[] = [];
    const normalized: string[] = [];
    const seen = new Set<string>();
    let consumed = -1;
    for (const token of tokens) {
      if (token.index <= consumed) {
        continue;
      }
      if (token.kind === "option-terminator") {
        const trailing = args.slice(token.index + 1);
        // The first operand can still name the command (uncutsql -- format path).
        if (!operands.length && trailing[0] && !trailing[0].startsWith("-")) {
          operands.push(trailing.shift()!);
        }
        return [...operands, ...normalized, "--", ...trailing];
      }
      if (token.kind === "positional") {
        operands.push(token.value);
        continue;
      }
      const flag = flags.get(token.name);
      if (!flag) {
        // Preserve unknown tokens verbatim, including negative numbers and short clusters.
        operands.push(args[token.index]!);
        consumed = token.index;
        continue;
      }
      if (seen.has(token.name)) {
        return yield* new UsageError({
          message:
            flag.optionalValue !== undefined
              ? "Choose only one decision-file option."
              : `${token.rawName} was specified more than once`,
        });
      }
      seen.add(token.name);
      let value = token.value;
      if (flag.type._tag === "Boolean") {
        if (value !== undefined) {
          return yield* new UsageError({ message: `${token.rawName} takes no value` });
        }
        value = "true";
      } else if (flag.optionalValue !== undefined && value === undefined) {
        const next = args[token.index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          consumed = token.index + 1;
        }
      }
      if (
        (value === undefined && flag.optionalValue === undefined) ||
        value === "" ||
        value?.startsWith("--")
      ) {
        return yield* new UsageError({ message: `${token.rawName} requires a value` });
      }
      normalized.push(value === undefined ? token.rawName : `${token.rawName}=${value}`);
    }
    return [...operands, ...normalized];
  });
