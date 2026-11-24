import { Effect } from "effect";

import { alternatives, make, parseError, prefixed } from "@uncutsql/codec";
import type { Read } from "@uncutsql/codec";

import { uppercaseAscii } from "../../lexer/characters.ts";
import { contextualNameKeywords } from "../../lexer/keywords.ts";
import { keyword } from "../../operators/keyword.ts";
import { skipSqliteTrivia } from "../../operators/trivia.ts";
import { startsWindowSyntax } from "../../operators/window-keyword.ts";
import { nameIdentifier, nameWithKeywords } from "../identifier.ts";

const explicit = prefixed(keyword("AS"), nameIdentifier, " ");

// Leave join modifiers and index hints for their clause codecs.
const sourceKeywords = new Set(contextualNameKeywords);
for (const word of "CROSS FULL INDEXED INNER LEFT NATURAL OUTER RIGHT".split(" ")) {
  sourceKeywords.delete(word);
}

// After a result expression, these words start pattern comparisons.
const resultKeywords = new Set(sourceKeywords);
for (const word of ["GLOB", "LIKE", "MATCH", "REGEXP"]) {
  resultKeywords.delete(word);
}

const implicit = (keywords: ReadonlySet<string>, afterParameter = false) => {
  const name = nameWithKeywords(keywords);
  return make<string>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* name.decode(cursor);
        const start = skipSqliteTrivia(cursor.source, cursor.offset);
        const word = uppercaseAscii(cursor.source.slice(start, result.next.offset));
        if (
          (word === "WINDOW" || (!afterParameter && (word === "OVER" || word === "FILTER"))) &&
          (yield* startsWindowSyntax(word, cursor, result.next))
        ) {
          return yield* Effect.fail(parseError(cursor, "implicit alias"));
        }
        return result;
      }),
    encode: name.encode,
  });
};

export const sourceAlias = alternatives(explicit, implicit(sourceKeywords));
export const resultAlias = alternatives(explicit, implicit(resultKeywords));

const parameterAlias = alternatives(explicit, implicit(resultKeywords, true));

// The closing character of $name(suffix) belongs to the parameter token, even
// when the parameter is the right operand of a larger expression.
export const resultAliasAfter = (expression: Read<unknown>) => {
  const { offset, source } = expression.next;
  if (source[offset - 1] === ")") {
    let node = expression.nodes.at(-1);
    while (node?.end === offset) {
      if (node.kind === "BindParameter") {
        return parameterAlias;
      }
      node = node.children.at(-1);
    }
  }
  return resultAlias;
};
