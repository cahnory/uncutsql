import { optional, transform } from "../../codec/index.ts";
import { punctuation } from "./punctuation.ts";

/** Optional on input; always print the canonical final semicolon. */
export const terminator = transform(
  optional(
    transform(punctuation(";"), {
      decode: () => true as const,
      encode: (_value: true) => undefined,
    }),
  ),
  {
    decode: (): void => undefined,
    encode: (_value: void) => true as const,
  },
);
