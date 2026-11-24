import { Effect } from "effect";

import { make, read } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

export const skipSqliteTrivia = (source: string, start: number): number => {
  let offset = start;
  while (offset < source.length) {
    if (/[\t\n\f\r ]/.test(source[offset]!)) {
      // A vertical tab can continue a SQLite whitespace token but cannot start one.
      do {
        offset++;
      } while (/[\t\n\v\f\r ]/.test(source[offset] ?? ""));
    } else if (source[offset] === "\uFEFF") {
      offset++;
    } else if (source.startsWith("--", offset)) {
      const end = source.indexOf("\n", offset + 2);
      offset = end < 0 ? source.length : end;
    } else if (offset + 2 < source.length && source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      offset = end < 0 ? source.length : end + 2;
    } else {
      break;
    }
  }
  return offset;
};

export const trivia: Codec<void> = make<void>({
  decode: ({ offset, source }) =>
    Effect.succeed(read(undefined, { offset: skipSqliteTrivia(source, offset), source })),
  encode: () => Effect.succeed(""),
});
