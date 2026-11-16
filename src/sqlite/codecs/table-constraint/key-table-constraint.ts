import { type Codec, optional, prefixed, repeat, struct, transform } from "../../../codec/index.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { conflictClause, type ConflictAction } from "../conflict-clause.ts";
import { indexedColumn, type IndexedColumn } from "../indexed-column.ts";

export interface KeyTableConstraint<Tag extends "PrimaryKey" | "Unique"> {
  readonly _tag: Tag;
  readonly columns: readonly IndexedColumn[];
  readonly onConflict?: ConflictAction;
}

export const keyTableConstraint = <const Tag extends "PrimaryKey" | "Unique">(
  tag: Tag,
  words: readonly string[],
): Codec<KeyTableConstraint<Tag>> =>
  prefixed(
    keywordSequence(words),
    transform(
      struct(
        {
          columns: parenthesized(
            repeat(indexedColumn, { min: 1, separator: punctuation(",", ", ") }),
          ),
          onConflict: optional(conflictClause),
        },
        " ",
      ),
      {
        decode: ({ columns, onConflict }): KeyTableConstraint<Tag> => ({
          _tag: tag,
          columns,
          ...(onConflict === undefined ? {} : { onConflict }),
        }),
        encode: (value: KeyTableConstraint<Tag>) => ({
          columns: value.columns,
          onConflict: value.onConflict,
        }),
      },
    ),
    " ",
  );
