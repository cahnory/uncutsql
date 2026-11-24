import { prefixed, repeat, struct, transform } from "@uncutsql/codec";

import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { foreignKeyClause } from "../foreign-key-clause.ts";
import type { ForeignKeyClause } from "../foreign-key-clause.ts";
import { nameIdentifier } from "../identifier.ts";

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
        columns: parenthesized(
          repeat(nameIdentifier, { min: 1, separator: punctuation(",", ", ") }),
        ),
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
