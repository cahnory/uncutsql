import { type Codec, located } from "@uncutsql/codec";
import { lexeme } from "../../operators/lexeme.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import type { Expression } from "./types.ts";

/** Keep grouping in the source map; the semantic tree already captures its meaning. */
export const parenthesizedExpression = (expression: Codec<Expression>): Codec<Expression> =>
  lexeme(located("ParenthesizedExpression", parenthesized(expression)));
