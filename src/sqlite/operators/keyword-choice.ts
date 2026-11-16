import { Effect, Result } from "effect";
import { type Codec, EncodeError, make, parseError, read } from "../../codec/index.ts";
import { mergeErrors } from "../../codec/model.ts";
import { keywordSequence } from "./keyword-sequence.ts";

export const keywordChoice = <const Words extends readonly [string, ...string[]]>(
  words: Words,
): Codec<Words[number]> => {
  const choices = words.map((word) => ({ word, syntax: keywordSequence(word.split(" ")) }));
  return make<Words[number]>({
    decode: (cursor) =>
      Effect.gen(function* () {
        let best = parseError(cursor, words);
        for (const { word, syntax } of choices) {
          const result = yield* Effect.result(syntax.decode(cursor));
          if (Result.isSuccess(result))
            return read(word, result.success.next, result.success.nodes);
          best = mergeErrors(best, result.failure);
        }
        return yield* Effect.fail(best);
      }),
    encode: (word) =>
      words.includes(word)
        ? Effect.succeed(word)
        : Effect.fail(new EncodeError({ message: `Expected ${words.join(" or ")}` })),
  });
};
