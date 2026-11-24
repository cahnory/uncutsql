import {
  document,
  followedBy,
  optional,
  prefixed,
  repeat,
  struct,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import type { Value } from "@uncutsql/codec";

import { flag } from "../operators/flag.ts";
import { keywordChoice } from "../operators/keyword-choice.ts";
import { keywordSequence } from "../operators/keyword-sequence.ts";
import { keyword } from "../operators/keyword.ts";
import { punctuation } from "../operators/punctuation.ts";
import { terminator } from "../operators/terminator.ts";
import { trivia } from "../operators/trivia.ts";
import { createRelationHeader } from "./create-table-header.ts";
import { expression } from "./expression.ts";
import { identifier } from "./identifier.ts";
import { tableReference } from "./table-reference.ts";
import { triggerAction } from "./trigger-action.ts";

const simpleEvent = <const Tag extends "INSERT" | "DELETE">(tag: Tag) =>
  transform(keyword(tag), {
    decode: () => ({ _tag: tag }),
    encode: (_event: { readonly _tag: Tag }) => undefined,
  });
const event = taggedUnion({
  INSERT: simpleEvent("INSERT"),
  DELETE: simpleEvent("DELETE"),
  UPDATE: transform(
    prefixed(
      keyword("UPDATE"),
      optional(
        prefixed(
          keyword("OF"),
          repeat(identifier, { min: 1, separator: punctuation(",", ", ") }),
          " ",
        ),
      ),
      " ",
    ),
    {
      decode: (columns) => ({ _tag: "UPDATE" as const, columns }),
      encode: (value) => value.columns,
    },
  ),
});
const syntax = struct(
  {
    header: createRelationHeader("TRIGGER"),
    timing: optional(keywordChoice(["BEFORE", "AFTER", "INSTEAD OF"])),
    event,
    target: prefixed(keyword("ON"), tableReference, " "),
    forEachRow: flag(keywordSequence(["FOR", "EACH", "ROW"])),
    when: optional(prefixed(keyword("WHEN"), expression, " ")),
    actions: prefixed(
      keyword("BEGIN"),
      followedBy(
        repeat(followedBy(triggerAction, punctuation(";")), { join: " ", min: 1 }),
        keyword("END"),
        " ",
      ),
      " ",
    ),
  },
  " ",
);
export const createTriggerBodyGrammar = transform(syntax, {
  decode: ({ header, ...body }) => ({ _tag: "CreateTrigger" as const, ...header, ...body }),
  encode: (value) => ({ header: value, ...value }),
});
export type CreateTrigger = Value<typeof createTriggerBodyGrammar>;
export const createTrigger = document(followedBy(createTriggerBodyGrammar, terminator), trivia);
