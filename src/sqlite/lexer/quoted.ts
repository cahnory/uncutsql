import { Effect } from "effect";
import { type Codec, EncodeError, make, parseError, read } from "../../codec/index.ts";

export const quoted = (open: string, close = open, doubles = true): Codec<string> =>
  make({
    decode: (cursor) =>
      Effect.suspend(() => {
        if (cursor.source[cursor.offset] !== open) return Effect.fail(parseError(cursor, open));
        let offset = cursor.offset + 1;
        let value = "";
        while (offset < cursor.source.length) {
          const char = cursor.source[offset]!;
          if (char === "\0")
            return Effect.fail(parseError({ ...cursor, offset }, "text without NUL", true));
          if (char === close) {
            if (doubles && cursor.source[offset + 1] === close) {
              value += close;
              offset += 2;
              continue;
            }
            return Effect.succeed(read(value, { ...cursor, offset: offset + 1 }));
          }
          value += char;
          offset++;
        }
        return Effect.fail(parseError({ ...cursor, offset }, `closing ${close}`, true));
      }),
    encode: (value) => {
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        (!doubles && value.includes(close))
      ) {
        return Effect.fail(
          new EncodeError({ message: `Value cannot be quoted with ${open}${close}` }),
        );
      }
      return Effect.succeed(
        open + (doubles ? value.replaceAll(close, close + close) : value) + close,
      );
    },
  });
