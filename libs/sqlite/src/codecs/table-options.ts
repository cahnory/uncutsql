import { type Value, repeat } from "@uncutsql/codec";
import { keywordChoice } from "../operators/keyword-choice.ts";
import { punctuation } from "../operators/punctuation.ts";

const tableOption = keywordChoice(["WITHOUT ROWID", "STRICT"]);
export type TableOption = Value<typeof tableOption>;

/** SQLite accepts either order and repeated options. Keep the explicit sequence. */
export const tableOptions = repeat(tableOption, { min: 1, separator: punctuation(",", ", ") });
