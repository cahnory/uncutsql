import { alternatives, prefixed } from "@uncutsql/codec";
import { explicitAliasKeywords } from "../../lexer/keywords.ts";
import { keyword } from "../../operators/keyword.ts";
import { nameWithKeywords } from "../identifier.ts";

const explicit = prefixed(keyword("AS"), nameWithKeywords(explicitAliasKeywords), " ");

// Leave join modifiers, index hints and window syntax for their clause codecs.
const sourceKeywords = new Set(explicitAliasKeywords);
for (const word of "CROSS FULL INDEXED INNER LEFT NATURAL OUTER RIGHT FILTER OVER WINDOW".split(
  " ",
))
  sourceKeywords.delete(word);

// After a result expression, these words start pattern comparisons.
const resultKeywords = new Set(sourceKeywords);
for (const word of ["GLOB", "LIKE", "MATCH", "REGEXP"]) resultKeywords.delete(word);

export const sourceAlias = alternatives(explicit, nameWithKeywords(sourceKeywords));
export const resultAlias = alternatives(explicit, nameWithKeywords(resultKeywords));
