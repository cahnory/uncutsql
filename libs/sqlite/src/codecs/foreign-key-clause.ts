import { located, optional, prefixed, repeat, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../operators/keyword.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { foreignKeyOption } from "./foreign-key/action.ts";
import type { ForeignKeyOption } from "./foreign-key/action.ts";
import { deferrability } from "./foreign-key/deferrable.ts";
import type { Deferrability } from "./foreign-key/deferrable.ts";
import { nameIdentifier } from "./identifier.ts";

export interface ForeignKeyClause {
  readonly columns?: readonly string[];
  readonly deferrability?: Deferrability;
  /** Retain the order of MATCH/ON clauses rather than grouping them by kind. */
  readonly options: readonly ForeignKeyOption[];
  readonly table: string;
}

export const foreignKeyClause: Codec<ForeignKeyClause> = located(
  "ForeignKeyClause",
  prefixed(
    keyword("REFERENCES"),
    transform(
      struct(
        {
          table: nameIdentifier,
          columns: optional(
            located(
              "ReferencedColumns",
              parenthesized(repeat(nameIdentifier, { min: 1, separator: punctuation(",", ", ") })),
            ),
          ),
          options: repeat(foreignKeyOption, { join: " " }),
          deferrability: optional(deferrability),
        },
        " ",
      ),
      {
        decode: ({ columns, deferrability, options, table }): ForeignKeyClause => ({
          options,
          table,
          ...(columns === undefined ? {} : { columns }),
          ...(deferrability === undefined ? {} : { deferrability }),
        }),
        encode: (value: ForeignKeyClause) => ({
          columns: value.columns,
          deferrability: value.deferrability,
          options: value.options,
          table: value.table,
        }),
      },
    ),
    " ",
  ),
);
