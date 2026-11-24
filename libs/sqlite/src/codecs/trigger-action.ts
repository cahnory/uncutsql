import { optional, prefixed, repeat, struct, taggedUnion, transform } from "@uncutsql/codec";
import type { Codec, Value } from "@uncutsql/codec";

import { keywordChoice } from "../operators/keyword-choice.ts";
import { keywordSequence } from "../operators/keyword-sequence.ts";
import { keyword } from "../operators/keyword.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { expression } from "./expression.ts";
import { identifier } from "./identifier.ts";
import { query } from "./query/query.ts";

const list = <A>(codec: Codec<A>) => repeat(codec, { min: 1, separator: punctuation(",", ", ") });
const onConflict = optional(
  prefixed(keyword("OR"), keywordChoice(["ROLLBACK", "ABORT", "FAIL", "IGNORE", "REPLACE"]), " "),
);
const where = optional(prefixed(keyword("WHERE"), expression, " "));
const select = query(expression);
const insert = struct(
  {
    conflict: onConflict,
    table: prefixed(keyword("INTO"), identifier, " "),
    columns: optional(parenthesized(list(identifier))),
    source: select,
  },
  " ",
);
const update = struct(
  {
    conflict: onConflict,
    table: identifier,
    assignments: prefixed(
      keyword("SET"),
      list(struct({ column: identifier, value: prefixed(punctuation("="), expression, " ") }, " ")),
      " ",
    ),
    where,
  },
  " ",
);
const remove = struct({ table: identifier, where }, " ");

const action = <const Tag extends string, A>(tag: Tag, syntax: Codec<A>) =>
  transform(syntax, {
    decode: (value) => ({ _tag: tag, value }),
    encode: (action: { readonly _tag: Tag; readonly value: A }) => action.value,
  });
export const triggerAction = taggedUnion({
  TriggerSelect: action("TriggerSelect", select),
  TriggerInsert: action("TriggerInsert", prefixed(keyword("INSERT"), insert, " ")),
  TriggerUpdate: action("TriggerUpdate", prefixed(keyword("UPDATE"), update, " ")),
  TriggerDelete: action(
    "TriggerDelete",
    prefixed(keywordSequence(["DELETE", "FROM"]), remove, " "),
  ),
});
export type TriggerAction = Value<typeof triggerAction>;
