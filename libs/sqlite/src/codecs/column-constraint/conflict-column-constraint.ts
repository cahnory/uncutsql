import { optional, prefixed, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { conflictClause } from "../conflict-clause.ts";
import type { ConflictAction } from "../conflict-clause.ts";

export interface ConflictColumnConstraint<Tag extends "NotNull" | "Unique"> {
  readonly _tag: Tag;
  readonly onConflict?: ConflictAction;
}

export const conflictColumnConstraint = <const Tag extends "NotNull" | "Unique">(
  tag: Tag,
  syntax: Codec<void>,
): Codec<ConflictColumnConstraint<Tag>> =>
  transform(prefixed(syntax, optional(conflictClause), " "), {
    decode: (onConflict): ConflictColumnConstraint<Tag> => ({
      _tag: tag,
      ...(onConflict === undefined ? {} : { onConflict }),
    }),
    encode: (value: ConflictColumnConstraint<Tag>) => value.onConflict,
  });
