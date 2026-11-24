import {
  type Codec,
  document,
  followedBy,
  optional,
  prefixed,
  repeat,
  struct,
  transform,
} from "@uncutsql/codec";
import { keyword } from "../operators/keyword.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { terminator } from "../operators/terminator.ts";
import { trivia } from "../operators/trivia.ts";
import { createRelationHeader, type CreateTableHeader } from "./create-table-header.ts";
import { expression } from "./expression.ts";
import { nameIdentifier } from "./identifier.ts";
import { query } from "./query/query.ts";
import type { Query } from "./query/types.ts";

export interface CreateView extends CreateTableHeader {
  readonly _tag: "CreateView";
  readonly columns?: readonly string[];
  readonly query: Query;
}

export const createViewBodyGrammar: Codec<CreateView> = transform(
  struct(
    {
      header: createRelationHeader("VIEW"),
      columns: optional(
        parenthesized(repeat(nameIdentifier, { min: 1, separator: punctuation(",", ", ") })),
      ),
      query: prefixed(keyword("AS"), query(expression, true), " "),
    },
    " ",
  ),
  {
    decode: ({ header, columns, query }): CreateView => ({
      _tag: "CreateView",
      ...header,
      ...(columns === undefined ? {} : { columns }),
      query,
    }),
    encode: (view: CreateView) => ({ header: view, columns: view.columns, query: view.query }),
  },
);
export const createView = document(followedBy(createViewBodyGrammar, terminator), trivia);
