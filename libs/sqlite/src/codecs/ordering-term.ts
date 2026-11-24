import { optional, prefixed, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordChoice } from "../operators/keyword-choice.ts";
import { keyword } from "../operators/keyword.ts";
import type { Expression, OrderingTerm } from "./expression/types.ts";

export const orderingTerm = (expression: Codec<Expression>): Codec<OrderingTerm> =>
  transform(
    struct(
      {
        expression,
        direction: optional(keywordChoice(["ASC", "DESC"])),
        nulls: optional(prefixed(keyword("NULLS"), keywordChoice(["FIRST", "LAST"]), " ")),
      },
      " ",
    ),
    {
      decode: ({ direction, expression, nulls }): OrderingTerm => ({
        expression,
        ...(direction === undefined ? {} : { direction }),
        ...(nulls === undefined ? {} : { nulls }),
      }),
      encode: (value: OrderingTerm) => ({
        direction: value.direction,
        expression: value.expression,
        nulls: value.nulls,
      }),
    },
  );
