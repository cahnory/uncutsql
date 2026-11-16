import { type Value, prefixed, taggedUnion, transform } from "../../../codec/index.ts";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { identifier } from "../identifier.ts";

const action = keywordChoice(["SET NULL", "SET DEFAULT", "CASCADE", "RESTRICT", "NO ACTION"]);
export type ForeignKeyAction = Value<typeof action>;
const on = <const Tag extends "OnDelete" | "OnUpdate">(tag: Tag, word: string) =>
  transform(prefixed(keywordSequence(["ON", word]), action, " "), {
    decode: (action) => ({ _tag: tag, action }),
    encode: (value: { readonly _tag: Tag; readonly action: ForeignKeyAction }) => value.action,
  });

export const foreignKeyOption = taggedUnion({
  OnDelete: on("OnDelete", "DELETE"),
  OnUpdate: on("OnUpdate", "UPDATE"),
  Match: transform(prefixed(keyword("MATCH"), identifier, " "), {
    decode: (name) => ({ _tag: "Match" as const, name }),
    encode: (value: { readonly _tag: "Match"; readonly name: string }) => value.name,
  }),
});
export type ForeignKeyOption = Value<typeof foreignKeyOption>;
