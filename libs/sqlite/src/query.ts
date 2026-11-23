import { document, followedBy } from "@uncutsql/codec";
import { expression } from "./codecs/expression.ts";
import { query } from "./codecs/query/query.ts";
import { terminator } from "./operators/terminator.ts";
import { trivia } from "./operators/trivia.ts";

/** A query body without its statement terminator. Supports SELECT cores and VALUES. */
export const queryGrammar = query(expression);
export const sqlQuery = document(followedBy(queryGrammar, terminator), trivia);
export type {
  Query,
  QueryCore,
  SelectCore,
  CompoundQuery,
  CompoundOperator,
  ValuesQuery,
  SelectQuery,
  ResultColumn,
  TableSource,
  FromClause,
  JoinedSource,
  JoinOperator,
  JoinModifier,
  JoinConstraint,
  TableReferenceSource,
  IndexHint,
  SubquerySource,
  GroupedSource,
  LimitClause,
} from "./codecs/query/types.ts";
