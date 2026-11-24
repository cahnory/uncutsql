import { Effect } from "effect";
import { alternatives, make, parseError, prefixed } from "@uncutsql/codec";
import { uppercaseAscii } from "../../lexer/characters.ts";
import { explicitAliasKeywords } from "../../lexer/keywords.ts";
import { keyword } from "../../operators/keyword.ts";
import { nameWithKeywords } from "../identifier.ts";
import { startsWindowSyntax } from "../../operators/window-keyword.ts";
import { skipSqliteTrivia } from "../../operators/trivia.ts";

const explicit = prefixed(keyword("AS"), nameWithKeywords(explicitAliasKeywords), " ");

// Leave join modifiers and index hints for their clause codecs.
const sourceKeywords = new Set(explicitAliasKeywords);
for (const word of "CROSS FULL INDEXED INNER LEFT NATURAL OUTER RIGHT".split(" "))
  sourceKeywords.delete(word);

// After a result expression, these words start pattern comparisons.
const resultKeywords = new Set(sourceKeywords);
for (const word of ["GLOB", "LIKE", "MATCH", "REGEXP"]) resultKeywords.delete(word);

const implicit = (keywords: ReadonlySet<string>) => {
  const name = nameWithKeywords(keywords);
  return make<string>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* name.decode(cursor);
        const start = skipSqliteTrivia(cursor.source, cursor.offset);
        const word = uppercaseAscii(cursor.source.slice(start, result.next.offset));
        if (
          (word === "WINDOW" || word === "OVER" || word === "FILTER") &&
          (yield* startsWindowSyntax(word, cursor, result.next))
        )
          return yield* Effect.fail(parseError(cursor, "implicit alias"));
        return result;
      }),
    encode: name.encode,
  });
};

export const sourceAlias = alternatives(explicit, implicit(sourceKeywords));
export const resultAlias = alternatives(explicit, implicit(resultKeywords));
