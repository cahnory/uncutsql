import { Effect } from "effect";
import { type Codec, EncodeError, located, make, parseError, read } from "../../codec/index.ts";
import { identifierPart } from "../lexer/characters.ts";
import { lexeme } from "../operators/lexeme.ts";

const values = ["CURRENT_TIME", "CURRENT_DATE", "CURRENT_TIMESTAMP", "TRUE", "FALSE"] as const;
export interface KeywordLiteral {
  readonly _tag: "KeywordLiteral";
  // TRUE/FALSE are contextual identifiers in SQLite. Preserve their spelling so
  // SQLite can resolve them against a schema; do not replace them with 1/0.
  readonly value: (typeof values)[number];
}

export const keywordLiteral: Codec<KeywordLiteral> = lexeme(
  located(
    "KeywordLiteral",
    make<KeywordLiteral>({
      decode: (cursor) => {
        let end = cursor.offset;
        while (identifierPart.test(cursor.source[end] ?? "")) end++;
        const word = cursor.source.slice(cursor.offset, end).toUpperCase();
        const value = values.find((value) => value === word);
        return value === undefined
          ? Effect.fail(parseError(cursor, values))
          : Effect.succeed(read({ _tag: "KeywordLiteral", value }, { ...cursor, offset: end }));
      },
      encode: ({ value }) =>
        values.includes(value)
          ? Effect.succeed(value)
          : Effect.fail(new EncodeError({ message: `Unknown literal keyword: ${value}` })),
    }),
  ),
);
