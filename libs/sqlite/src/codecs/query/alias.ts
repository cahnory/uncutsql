import { alternatives, located, prefixed } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { identifier } from "../identifier.ts";

import { quoted } from "../../lexer/quoted.ts";
import { lexeme } from "../../operators/lexeme.ts";

const aliasName = alternatives(identifier, lexeme(located("Identifier", quoted("'"))));

/** Accept implicit aliases; emit explicit AS to preserve clause boundaries. */
export const alias = alternatives(prefixed(keyword("AS"), aliasName, " "), aliasName);
