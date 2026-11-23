import { alternatives, prefixed } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { identifier } from "../identifier.ts";

/** Accept implicit aliases; emit explicit AS to preserve clause boundaries. */
export const alias = alternatives(prefixed(keyword("AS"), identifier, " "), identifier);
