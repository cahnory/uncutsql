import { Effect } from "effect";

import { alternatives, EncodeError, located, make, parseError, read } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { identifierPart, identifierStart, uppercaseAscii } from "../lexer/characters.ts";
import { contextualNameKeywords, keywords } from "../lexer/keywords.ts";
import { quoted } from "../lexer/quoted.ts";
import { lexeme } from "../operators/lexeme.ts";

const bareIdentifier = (allowedKeywords?: ReadonlySet<string>): Codec<string> =>
  make({
    decode: (cursor) => {
      if (!identifierStart.test(cursor.source[cursor.offset] ?? "")) {
        return Effect.fail(parseError(cursor, "identifier"));
      }
      let end = cursor.offset + 1;
      while (identifierPart.test(cursor.source[end] ?? "")) {
        end++;
      }
      const value = cursor.source.slice(cursor.offset, end);
      const word = uppercaseAscii(value);
      return keywords.has(word) && !allowedKeywords?.has(word)
        ? Effect.fail(parseError(cursor, "quoted identifier (reserved keyword)"))
        : Effect.succeed(read(value, { ...cursor, offset: end }));
    },
    encode: (value) =>
      /^[A-Za-z_\u0080-\uffff][A-Za-z_0-9$\u0080-\uffff]*$/.test(value) &&
      !keywords.has(uppercaseAscii(value))
        ? Effect.succeed(value)
        : Effect.fail(new EncodeError({ message: "Invalid bare identifier" })),
  });

/** Always emit double quotes, including for bare identifiers accepted during parsing. */
const identifierWithKeywords = (allowedKeywords?: ReadonlySet<string>) =>
  lexeme(
    located(
      "Identifier",
      alternatives(
        quoted('"'),
        quoted("`"),
        quoted("[", "]", false),
        bareIdentifier(allowedKeywords),
      ),
    ),
  );

export const identifier = identifierWithKeywords();

/** SQLite also accepts string tokens in grammar positions that require a name. */
const stringName = lexeme(located("Identifier", quoted("'")));
export const nameWithKeywords = (allowed: ReadonlySet<string>) =>
  alternatives(identifierWithKeywords(allowed), stringName);
export const nameIdentifier = nameWithKeywords(contextualNameKeywords);
