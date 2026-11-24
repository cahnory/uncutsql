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
import { keywordSequence } from "../operators/keyword-sequence.ts";
import { keywordChoice } from "../operators/keyword-choice.ts";
import { flag } from "../operators/flag.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { terminator } from "../operators/terminator.ts";
import { trivia } from "../operators/trivia.ts";
import { identifier } from "./identifier.ts";
import { tableReference } from "./table-reference.ts";
import { expression, type Expression } from "./expression.ts";

export interface IndexTerm {
  readonly expression: Expression;
  readonly direction?: "ASC" | "DESC";
}
export interface CreateIndex {
  readonly _tag: "CreateIndex";
  readonly name: string;
  readonly schema?: string;
  readonly table: string;
  readonly unique: boolean;
  readonly ifNotExists: boolean;
  readonly terms: readonly IndexTerm[];
  readonly where?: Expression;
}
// COLLATE is part of the expression. Index terms do not accept NULLS FIRST/LAST.
export const indexTerm: Codec<IndexTerm> = transform(
  struct({ expression, direction: optional(keywordChoice(["ASC", "DESC"])) }, " "),
  {
    decode: ({ expression, direction }): IndexTerm => ({
      expression,
      ...(direction === undefined ? {} : { direction }),
    }),
    encode: (value: IndexTerm) => ({ expression: value.expression, direction: value.direction }),
  },
);
export const createIndexBodyGrammar: Codec<CreateIndex> = prefixed(
  keyword("CREATE"),
  transform(
    struct(
      {
        unique: flag(keyword("UNIQUE")),
        indexKeyword: keyword("INDEX"),
        ifNotExists: flag(keywordSequence(["IF", "NOT", "EXISTS"])),
        reference: tableReference,
        table: prefixed(keyword("ON"), identifier, " "),
        terms: parenthesized(repeat(indexTerm, { min: 1, separator: punctuation(",", ", ") })),
        where: optional(prefixed(keyword("WHERE"), expression, " ")),
      },
      " ",
    ),
    {
      decode: ({ unique, ifNotExists, reference, table, terms, where }): CreateIndex => ({
        _tag: "CreateIndex",
        unique,
        ifNotExists,
        ...reference,
        table,
        terms,
        ...(where === undefined ? {} : { where }),
      }),
      encode: (value: CreateIndex) => ({
        unique: value.unique,
        ifNotExists: value.ifNotExists,
        indexKeyword: undefined,
        reference: {
          name: value.name,
          ...(value.schema === undefined ? {} : { schema: value.schema }),
        },
        table: value.table,
        terms: value.terms,
        where: value.where,
      }),
    },
  ),
  " ",
);
export const createIndex = document(followedBy(createIndexBodyGrammar, terminator), trivia);
