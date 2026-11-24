import { Effect } from "effect";

import { make, parseError, read } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { lexeme } from "./lexeme.ts";

export const punctuation = (text: string, printed = text): Codec<void> =>
  lexeme(
    make<void>({
      decode: (cursor) =>
        cursor.source.startsWith(text, cursor.offset)
          ? Effect.succeed(read(undefined, { ...cursor, offset: cursor.offset + text.length }))
          : Effect.fail(parseError(cursor, JSON.stringify(text))),
      encode: () => Effect.succeed(printed),
    }),
  );
