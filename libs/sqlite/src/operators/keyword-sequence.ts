import { transform, tuple } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "./keyword.ts";

/** Match a phrase without committing on a shared first word. */
export const keywordSequence = (words: readonly string[]): Codec<void> =>
  transform(tuple(words.map(keyword), " "), {
    decode: (): void => undefined,
    encode: () => words.map(() => undefined),
  });
