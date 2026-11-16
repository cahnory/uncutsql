import { prefixed, repeat, struct, transform } from "../../../codec/index.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { identifier } from "../identifier.ts";
import { foreignKeyClause, type ForeignKeyClause } from "../foreign-key-clause.ts";

export interface ForeignKeyTableConstraint {
  readonly _tag: "ForeignKey";
  readonly columns: readonly string[];
  readonly references: ForeignKeyClause;
}

export const foreignKeyTableConstraint = prefixed(
  keywordSequence(["FOREIGN", "KEY"]),
  transform(
    struct(
      {
        columns: parenthesized(repeat(identifier, { min: 1, separator: punctuation(",", ", ") })),
        references: foreignKeyClause,
      },
      " ",
    ),
    {
      decode: (value): ForeignKeyTableConstraint => ({ _tag: "ForeignKey", ...value }),
      encode: (value: ForeignKeyTableConstraint) => ({
        columns: value.columns,
        references: value.references,
      }),
    },
  ),
  " ",
);
