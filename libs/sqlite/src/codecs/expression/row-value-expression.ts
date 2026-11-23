import { type Codec, located, repeat, transform } from "@uncutsql/codec";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression, RowValueExpression } from "./types.ts";

export const rowValueExpression = (expression: Codec<Expression>): Codec<RowValueExpression> =>
  located(
    "RowValueExpression",
    transform(parenthesized(repeat(expression, { min: 2, separator: punctuation(",", ", ") })), {
      decode: (values): RowValueExpression => ({ _tag: "RowValueExpression", values }),
      encode: (value: RowValueExpression) => value.values,
    }),
  );
