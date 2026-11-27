import { createInterface } from "node:readline";

import { confirm, intro, isCancel, outro } from "@clack/prompts";
import { Console, Effect } from "effect";

import { interactiveTerminal } from "../terminal.ts";

export const promptIO = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    try: operation,
  });

const openConversation = (cancelled: string) => {
  const output = process.stderr;
  const reader = interactiveTerminal()
    ? undefined
    : createInterface({ input: process.stdin, output });
  reader?.on("SIGINT", () => reader.close());
  const lines = reader?.[Symbol.asyncIterator]();
  const line =
    lines &&
    (async (message: string) => {
      output.write(message);
      const result = await lines.next();
      return result.done ? undefined : result.value.trim();
    });
  function answer<A>(value: A): Exclude<A, symbol | undefined>;
  function answer(value: unknown) {
    if (typeof value === "symbol" || value === undefined) {
      throw new Error(cancelled);
    }
    return value;
  }
  return {
    answer,
    close: () => reader?.close(),
    confirm: async (message: string, eofDeclines: boolean) => {
      if (line) {
        const value = await line(`${message} [y/N] `);
        return value === undefined && eofDeclines ? false : /^(y|yes)$/i.test(answer(value));
      }
      const value = await confirm({ initialValue: false, message, output });
      return !isCancel(value) && value;
    },
    line,
    output,
  };
};

export type Conversation = ReturnType<typeof openConversation>;

export const withConversation = <A, E, R>(
  cancelled: string,
  use: (conversation: Conversation) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => openConversation(cancelled)),
    use,
    (conversation) => Effect.sync(conversation.close),
  );

export const reportCommand = <E, R>(title: string | undefined, run: Effect.Effect<string, E, R>) =>
  Effect.gen(function* () {
    if (!title || !interactiveTerminal() || !process.stdout.isTTY) {
      return yield* Console.log((yield* run).trimEnd());
    }
    intro(title, { output: process.stderr });
    const message = yield* run;
    outro(message.trimEnd(), { output: process.stderr });
  });
