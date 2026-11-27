import { optional, prefixed, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordChoice } from "../operators/keyword-choice.ts";
import { keyword } from "../operators/keyword.ts";
import { collationName, tableKeyColumnName } from "./identifier.ts";

/** Table PRIMARY KEY/UNIQUE columns cannot be arbitrary index expressions. */
export interface IndexedColumn {
  readonly collation?: string;
  readonly column: string;
  readonly order?: "ASC" | "DESC";
}

export const indexedColumn: Codec<IndexedColumn> = transform(
  struct(
    {
      column: tableKeyColumnName,
      collation: optional(prefixed(keyword("COLLATE"), collationName, " ")),
      order: optional(keywordChoice(["ASC", "DESC"])),
    },
    " ",
  ),
  {
    decode: ({ collation, column, order }): IndexedColumn => ({
      column,
      ...(collation === undefined ? {} : { collation }),
      ...(order === undefined ? {} : { order }),
    }),
    encode: (value: IndexedColumn) => ({
      collation: value.collation,
      column: value.column,
      order: value.order,
    }),
  },
);
