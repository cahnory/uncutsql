import { type Codec, located, prefixed, repeat, transform } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression } from "../expression/types.ts";
import type { ValuesQuery } from "./types.ts";

export const valuesQuery = (expression: Codec<Expression>): Codec<ValuesQuery> =>
  located(
    "ValuesQuery",
    transform(
      prefixed(
        keyword("VALUES"),
        repeat(parenthesized(repeat(expression, { min: 1, separator: punctuation(",", ", ") })), {
          min: 1,
          separator: punctuation(",", ", "),
        }),
        " ",
      ),
      {
        decode: (rows): ValuesQuery => ({ _tag: "ValuesQuery", rows }),
        encode: (value: ValuesQuery) => value.rows,
      },
    ),
  );
