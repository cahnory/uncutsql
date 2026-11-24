import { located, prefixed, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { query } from "../query/query.ts";
import type { ExistsExpression, Expression, SubqueryExpression } from "./types.ts";

export const subqueryExpression = (expression: Codec<Expression>): Codec<SubqueryExpression> =>
  located(
    "SubqueryExpression",
    transform(parenthesized(query(expression)), {
      decode: (query): SubqueryExpression => ({ _tag: "SubqueryExpression", query }),
      encode: (value: SubqueryExpression) => value.query,
    }),
  );

export const existsExpression = (expression: Codec<Expression>): Codec<ExistsExpression> =>
  located(
    "ExistsExpression",
    transform(prefixed(keyword("EXISTS"), parenthesized(query(expression)), " "), {
      decode: (query): ExistsExpression => ({ _tag: "ExistsExpression", query }),
      encode: (value: ExistsExpression) => value.query,
    }),
  );
