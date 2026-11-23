import { type Codec, prefixed, repeat, taggedUnion, transform } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { identifier } from "../identifier.ts";
import type { Expression } from "../expression/types.ts";
import type { JoinConstraint } from "./types.ts";

export const joinConstraint = (expression: Codec<Expression>): Codec<JoinConstraint> =>
  taggedUnion({
    On: transform(prefixed(keyword("ON"), expression, " "), {
      decode: (expression) => ({ _tag: "On" as const, expression }),
      encode: (value) => value.expression,
    }),
    Using: transform(
      prefixed(
        keyword("USING"),
        parenthesized(repeat(identifier, { min: 1, separator: punctuation(",", ", ") })),
        " ",
      ),
      {
        decode: (columns) => ({ _tag: "Using" as const, columns }),
        encode: (value) => value.columns,
      },
    ),
  });
