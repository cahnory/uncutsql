import { type Codec, prefixed, transform } from "../../../codec/index.ts";
import { keyword } from "../../operators/keyword.ts";
import { expression, type Expression } from "../expression.ts";
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
