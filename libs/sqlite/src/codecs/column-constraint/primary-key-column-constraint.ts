import { type Codec, optional, prefixed, struct, transform } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { conflictClause, type ConflictAction } from "../conflict-clause.ts";

export interface PrimaryKeyColumnConstraint {
  readonly _tag: "PrimaryKey";
  readonly order?: "ASC" | "DESC";
  readonly onConflict?: ConflictAction;
  readonly autoIncrement?: true;
}

const autoIncrement = transform(keyword("AUTOINCREMENT"), {
  decode: () => true as const,
  encode: (_value: true) => undefined,
});

export const primaryKeyColumnConstraint: Codec<PrimaryKeyColumnConstraint> = transform(
  prefixed(
    keywordSequence(["PRIMARY", "KEY"]),
    struct(
      {
        order: optional(keywordChoice(["ASC", "DESC"])),
        onConflict: optional(conflictClause),
        autoIncrement: optional(autoIncrement),
      },
      " ",
    ),
    " ",
  ),
  {
    decode: ({ order, onConflict, autoIncrement }): PrimaryKeyColumnConstraint => ({
      _tag: "PrimaryKey",
      ...(order === undefined ? {} : { order }),
      ...(onConflict === undefined ? {} : { onConflict }),
      ...(autoIncrement === undefined ? {} : { autoIncrement }),
    }),
    encode: (value: PrimaryKeyColumnConstraint) => ({
      order: value.order,
      onConflict: value.onConflict,
      autoIncrement: value.autoIncrement,
    }),
  },
);
