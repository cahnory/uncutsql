import { type Codec, optional, prefixed, struct, transform } from "@uncutsql/codec";
import { keyword } from "../operators/keyword.ts";
import { keywordChoice } from "../operators/keyword-choice.ts";
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
      decode: ({ expression, direction, nulls }): OrderingTerm => ({
        expression,
        ...(direction === undefined ? {} : { direction }),
        ...(nulls === undefined ? {} : { nulls }),
      }),
      encode: (value: OrderingTerm) => ({
        expression: value.expression,
        direction: value.direction,
        nulls: value.nulls,
      }),
    },
  );
