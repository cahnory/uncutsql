import { prefixed } from "@uncutsql/codec";
import type { Value } from "@uncutsql/codec";

import { keywordChoice } from "../operators/keyword-choice.ts";
import { keywordSequence } from "../operators/keyword-sequence.ts";

export const conflictClause = prefixed(
  keywordSequence(["ON", "CONFLICT"]),
  keywordChoice(["ROLLBACK", "ABORT", "FAIL", "IGNORE", "REPLACE"]),
  " ",
);
export type ConflictAction = Value<typeof conflictClause>;
