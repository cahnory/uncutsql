import { document, followedBy } from "@uncutsql/codec";
import { expression } from "./codecs/expression.ts";
import { valuesQuery } from "./codecs/query/values-query.ts";
import { terminator } from "./operators/terminator.ts";
import { trivia } from "./operators/trivia.ts";

/** A query body without its statement terminator. Currently supports VALUES. */
export const queryGrammar = valuesQuery(expression);
export const sqlQuery = document(followedBy(queryGrammar, terminator), trivia);
export type { Query, ValuesQuery } from "./codecs/query/types.ts";
