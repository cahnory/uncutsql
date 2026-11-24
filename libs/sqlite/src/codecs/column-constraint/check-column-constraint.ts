import { prefixed, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import { expression } from "../expression.ts";
import type { Expression } from "../expression.ts";
import { parenthesizedExpression } from "../expression/parenthesized-expression.ts";

export interface CheckColumnConstraint {
  readonly _tag: "Check";
  readonly expression: Expression;
}

export const checkColumnConstraint: Codec<CheckColumnConstraint> = transform(
  prefixed(keyword("CHECK"), parenthesizedExpression(expression), " "),
  {
    decode: (expression): CheckColumnConstraint => ({ _tag: "Check", expression }),
    encode: (value: CheckColumnConstraint) => value.expression,
  },
);
