import { Effect } from "effect";
import { type Codec, make, read } from "@uncutsql/codec";

export const skipSqliteTrivia = (source: string, start: number): number => {
  let offset = start;
  while (offset < source.length) {
    if (/[\t\n\f\r ]/.test(source[offset]!)) {
      // A vertical tab can continue a SQLite whitespace token but cannot start one.
      do offset++;
      while (/[\t\n\v\f\r ]/.test(source[offset] ?? ""));
    } else if (source[offset] === "\uFEFF") {
      offset++;
    } else if (source.startsWith("--", offset)) {
      const end = source.indexOf("\n", offset + 2);
      offset = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      offset = end < 0 ? source.length : end + 2;
    } else break;
  }
  return offset;
};

export const trivia: Codec<void> = make<void>({
  decode: ({ source, offset }) =>
    Effect.succeed(read(undefined, { source, offset: skipSqliteTrivia(source, offset) })),
  encode: () => Effect.succeed(""),
});
