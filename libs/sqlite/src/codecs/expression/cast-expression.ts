import { located, prefixed, transform, tuple } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { columnType } from "../type-name.ts";
import type { CastExpression, Expression } from "./types.ts";

/** CAST is syntax, not an ordinary function call. Preserve the declared type spelling. */
export const castExpression = (expression: Codec<Expression>): Codec<CastExpression> =>
  located(
    "CastExpression",
    transform(
      prefixed(
        keyword("CAST"),
        parenthesized(tuple([expression, prefixed(keyword("AS"), columnType, " ")], " ")),
      ),
      {
        decode: ([operand, typeName]): CastExpression => ({
          _tag: "CastExpression",
          operand,
          typeName,
        }),
        encode: (value: CastExpression) => [value.operand, value.typeName] as const,
      },
    ),
  );
