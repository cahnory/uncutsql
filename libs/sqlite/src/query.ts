import { document, followedBy, taggedUnion } from "@uncutsql/codec";
import { expression } from "./codecs/expression.ts";
import { selectQuery } from "./codecs/query/select-query.ts";
import { valuesQuery } from "./codecs/query/values-query.ts";
import { terminator } from "./operators/terminator.ts";
import { trivia } from "./operators/trivia.ts";

/** A query body without its statement terminator. Supports SELECT cores and VALUES. */
export const queryGrammar = taggedUnion({
  ValuesQuery: valuesQuery(expression),
  SelectQuery: selectQuery(expression),
});
export const sqlQuery = document(followedBy(queryGrammar, terminator), trivia);
export type {
  Query,
  ValuesQuery,
  SelectQuery,
  ResultColumn,
  TableSource,
  LimitClause,
} from "./codecs/query/types.ts";
