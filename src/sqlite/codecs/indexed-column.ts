import { type Codec, optional, prefixed, struct, transform } from "../../codec/index.ts";
import { keyword } from "../operators/keyword.ts";
import { keywordChoice } from "../operators/keyword-choice.ts";
import { identifier } from "./identifier.ts";

/** Table PRIMARY KEY/UNIQUE columns cannot be arbitrary index expressions. */
export interface IndexedColumn {
  readonly column: string;
  readonly collation?: string;
  readonly order?: "ASC" | "DESC";
}

export const indexedColumn: Codec<IndexedColumn> = transform(
  struct(
    {
      column: identifier,
      collation: optional(prefixed(keyword("COLLATE"), identifier, " ")),
      order: optional(keywordChoice(["ASC", "DESC"])),
    },
    " ",
  ),
  {
    decode: ({ column, collation, order }): IndexedColumn => ({
      column,
      ...(collation === undefined ? {} : { collation }),
      ...(order === undefined ? {} : { order }),
    }),
    encode: (value: IndexedColumn) => ({
      column: value.column,
      collation: value.collation,
      order: value.order,
    }),
  },
);
