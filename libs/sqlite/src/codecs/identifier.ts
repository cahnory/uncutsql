import { Effect } from "effect";
import {
  type Codec,
  EncodeError,
  alternatives,
  located,
  make,
  parseError,
  read,
} from "@uncutsql/codec";
import { identifierStart, identifierPart, uppercaseAscii } from "../lexer/characters.ts";
import { keywords } from "../lexer/keywords.ts";
import { quoted } from "../lexer/quoted.ts";
import { lexeme } from "../operators/lexeme.ts";

const bareIdentifier: Codec<string> = make({
  decode: (cursor) => {
    if (!identifierStart.test(cursor.source[cursor.offset] ?? "")) {
      return Effect.fail(parseError(cursor, "identifier"));
    }
    let end = cursor.offset + 1;
    while (identifierPart.test(cursor.source[end] ?? "")) end++;
    const value = cursor.source.slice(cursor.offset, end);
    return keywords.has(uppercaseAscii(value))
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
export const identifier = lexeme(
  located(
    "Identifier",
    alternatives(quoted('"'), quoted("`"), quoted("[", "]", false), bareIdentifier),
  ),
);
