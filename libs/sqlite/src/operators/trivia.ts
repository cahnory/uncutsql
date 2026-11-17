import { Effect } from "effect";
import { type Codec, make, read } from "@uncutsql/codec";

export const trivia: Codec<void> = make<void>({
  decode: (cursor) =>
    Effect.sync(() => {
      const { source } = cursor;
      let offset = cursor.offset;
      while (offset < source.length) {
        if (/[\t\n\v\f\r ]/.test(source[offset]!)) {
          offset++;
        } else if (source.startsWith("--", offset)) {
          const end = source.indexOf("\n", offset + 2);
          offset = end < 0 ? source.length : end + 1;
        } else if (source.startsWith("/*", offset)) {
          const end = source.indexOf("*/", offset + 2);
          offset = end < 0 ? source.length : end + 2;
        } else break;
      }
      return read(undefined, { source, offset });
    }),
  encode: () => Effect.succeed(""),
});
