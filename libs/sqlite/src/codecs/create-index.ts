import {
  document,
  followedBy,
  optional,
  prefixed,
  repeat,
  struct,
  transform,
} from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { flag, ifNotExists } from "../operators/flag.ts";
import { keywordChoice } from "../operators/keyword-choice.ts";
import { keyword } from "../operators/keyword.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { terminator } from "../operators/terminator.ts";
import { trivia } from "../operators/trivia.ts";
import { expression } from "./expression.ts";
import type { Expression } from "./expression.ts";
import { nameIdentifier } from "./identifier.ts";
import { tableReference } from "./table-reference.ts";

export interface IndexTerm {
  readonly direction?: "ASC" | "DESC";
  readonly expression: Expression;
}
export interface CreateIndex {
  readonly _tag: "CreateIndex";
  readonly ifNotExists: boolean;
  readonly name: string;
  readonly schema?: string;
  readonly table: string;
  readonly terms: readonly IndexTerm[];
  readonly unique: boolean;
  readonly where?: Expression;
}
// COLLATE is part of the expression. Index terms do not accept NULLS FIRST/LAST.
export const indexTerm: Codec<IndexTerm> = transform(
  struct({ expression, direction: optional(keywordChoice(["ASC", "DESC"])) }, " "),
  {
    decode: ({ direction, expression }): IndexTerm => ({
      expression,
      ...(direction === undefined ? {} : { direction }),
    }),
    encode: (value: IndexTerm) => ({ direction: value.direction, expression: value.expression }),
  },
);
export const createIndexBodyGrammar: Codec<CreateIndex> = prefixed(
  keyword("CREATE"),
  transform(
    struct(
      {
        unique: flag(keyword("UNIQUE")),
        indexKeyword: keyword("INDEX"),
        ifNotExists,
        reference: tableReference,
        table: prefixed(keyword("ON"), nameIdentifier, " "),
        terms: parenthesized(repeat(indexTerm, { min: 1, separator: punctuation(",", ", ") })),
        where: optional(prefixed(keyword("WHERE"), expression, " ")),
      },
      " ",
    ),
    {
      decode: ({ ifNotExists, reference, table, terms, unique, where }): CreateIndex => ({
        _tag: "CreateIndex",
        ifNotExists,
        unique,
        ...reference,
        table,
        terms,
        ...(where === undefined ? {} : { where }),
      }),
      encode: (value: CreateIndex) => ({
        ifNotExists: value.ifNotExists,
        indexKeyword: undefined,
        reference: {
          name: value.name,
          ...(value.schema === undefined ? {} : { schema: value.schema }),
        },
        table: value.table,
        terms: value.terms,
        unique: value.unique,
        where: value.where,
      }),
    },
  ),
  " ",
);
export const createIndex = document(followedBy(createIndexBodyGrammar, terminator), trivia);
