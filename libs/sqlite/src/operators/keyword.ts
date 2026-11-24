import { Effect } from "effect";
import { type Codec, make, parseError, read } from "@uncutsql/codec";
import { identifierPart, uppercaseAscii } from "../lexer/characters.ts";
import { lexeme } from "./lexeme.ts";

export const keyword = (text: string): Codec<void> => {
  const canonical = uppercaseAscii(text);
  if (!/^[A-Z_]+$/.test(canonical)) throw new TypeError("keyword requires one word");
  return lexeme(
    make<void>({
      decode: (cursor) => {
        const end = cursor.offset + canonical.length;
        const matches = uppercaseAscii(cursor.source.slice(cursor.offset, end)) === canonical;
        const boundary = !identifierPart.test(cursor.source[end] ?? "");
        return matches && boundary
          ? Effect.succeed(read(undefined, { ...cursor, offset: end }))
          : Effect.fail(parseError(cursor, canonical));
      },
      encode: () => Effect.succeed(canonical),
    }),
  );
};
