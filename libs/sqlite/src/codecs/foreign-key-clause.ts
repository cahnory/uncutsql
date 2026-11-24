import {
  type Codec,
  located,
  optional,
  prefixed,
  repeat,
  struct,
  transform,
} from "@uncutsql/codec";
import { keyword } from "../operators/keyword.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { nameIdentifier } from "./identifier.ts";
import { foreignKeyOption, type ForeignKeyOption } from "./foreign-key/action.ts";
import { deferrability, type Deferrability } from "./foreign-key/deferrable.ts";

export interface ForeignKeyClause {
  readonly table: string;
  readonly columns?: readonly string[];
  /** Retain the order of MATCH/ON clauses rather than grouping them by kind. */
  readonly options: readonly ForeignKeyOption[];
  readonly deferrability?: Deferrability;
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
        decode: ({ table, columns, options, deferrability }): ForeignKeyClause => ({
          table,
          options,
          ...(columns === undefined ? {} : { columns }),
          ...(deferrability === undefined ? {} : { deferrability }),
        }),
        encode: (value: ForeignKeyClause) => ({
          table: value.table,
          columns: value.columns,
          options: value.options,
          deferrability: value.deferrability,
        }),
      },
    ),
    " ",
  ),
);
