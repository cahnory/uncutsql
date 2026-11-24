import { optional, prefixed, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { keyword } from "../../operators/keyword.ts";
import { conflictClause } from "../conflict-clause.ts";
import type { ConflictAction } from "../conflict-clause.ts";

export interface PrimaryKeyColumnConstraint {
  readonly _tag: "PrimaryKey";
  readonly autoIncrement?: true;
  readonly onConflict?: ConflictAction;
  readonly order?: "ASC" | "DESC";
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
    decode: ({ autoIncrement, onConflict, order }): PrimaryKeyColumnConstraint => ({
      _tag: "PrimaryKey",
      ...(order === undefined ? {} : { order }),
      ...(onConflict === undefined ? {} : { onConflict }),
      ...(autoIncrement === undefined ? {} : { autoIncrement }),
    }),
    encode: (value: PrimaryKeyColumnConstraint) => ({
      autoIncrement: value.autoIncrement,
      onConflict: value.onConflict,
      order: value.order,
    }),
  },
);
