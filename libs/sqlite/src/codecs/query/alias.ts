import { alternatives, prefixed } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { explicitAliasKeywords } from "../../lexer/keywords.ts";
import { nameIdentifier, nameWithKeywords } from "../identifier.ts";

/** Accept implicit aliases; emit explicit AS to preserve clause boundaries. */
export const alias = alternatives(
  prefixed(keyword("AS"), nameWithKeywords(explicitAliasKeywords), " "),
  nameIdentifier,
);
