import { Effect, Result } from "effect";
import { type Codec, document, EncodeError, make, read } from "@uncutsql/codec";
import { contextualNameKeywords, windowLookaheadKeywords } from "../lexer/keywords.ts";
import { nameWithKeywords } from "./identifier.ts";
import { lexeme } from "../operators/lexeme.ts";

/** SQLite compares window-name tokens without removing identifier quotes. */
const rawName = (keywords: ReadonlySet<string>): Codec<string> => {
  const identifier = nameWithKeywords(keywords);
  return lexeme(
    make<string>({
      decode: (cursor) =>
        Effect.map(identifier.decode(cursor), (result) =>
          read(cursor.source.slice(cursor.offset, result.next.offset), result.next, result.nodes),
        ),
      encode: (value: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(document(identifier).decode(value));
          if (Result.isFailure(result) || value.trim() !== value || /^(?:--|\/\*)/.test(value)) {
            return yield* Effect.fail(new EncodeError({ message: "Expected a window-name token" }));
          }
          return value;
        }),
    }),
  );
};

export const windowNameAfterKeyword = rawName(windowLookaheadKeywords);
export const windowName = rawName(contextualNameKeywords);

// At the start of a definition these tokens introduce clauses.
const baseKeywords = new Set(contextualNameKeywords);
for (const word of ["PARTITION", "RANGE", "ROWS", "GROUPS"]) baseKeywords.delete(word);
export const baseWindowName = rawName(baseKeywords);
