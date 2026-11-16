import { type Codec, transform, tuple } from "../../codec/index.ts";
import { keyword } from "./keyword.ts";

/** Match a phrase without committing on a shared first word. */
export const keywordSequence = (words: readonly string[]): Codec<void> =>
  transform(tuple(words.map(keyword), " "), {
    decode: (): void => undefined,
    encode: () => words.map(() => undefined),
  });
