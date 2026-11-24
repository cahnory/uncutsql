import { optional, prefixed, struct, taggedUnion, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression } from "../expression/types.ts";
import type { LimitClause } from "./types.ts";

/** Keep comma syntax: reordering its expressions would renumber anonymous parameters. */
export const limitClause = (expression: Codec<Expression>): Codec<LimitClause> => {
  const tail = taggedUnion({
    Offset: transform(prefixed(keyword("OFFSET"), expression, " "), {
      decode: (value) => ({ _tag: "Offset" as const, value }),
      encode: (value) => value.value,
    }),
    Comma: transform(prefixed(punctuation(",", ", "), expression), {
      decode: (value) => ({ _tag: "Comma" as const, value }),
      encode: (value) => value.value,
    }),
  });
  return transform(
    prefixed(keyword("LIMIT"), struct({ first: expression, tail: optional(tail) }, " "), " "),
    {
      decode: ({ first, tail }): LimitClause =>
        tail?._tag === "Comma"
          ? { _tag: "CommaLimit", count: tail.value, offset: first }
          : {
              _tag: "CountLimit",
              count: first,
              ...(tail === undefined ? {} : { offset: tail.value }),
            },
      encode: (value: LimitClause) =>
        value._tag === "CommaLimit"
          ? { first: value.offset, tail: { _tag: "Comma" as const, value: value.count } }
          : {
              first: value.count,
              tail:
                value.offset === undefined
                  ? undefined
                  : { _tag: "Offset" as const, value: value.offset },
            },
    },
  );
};
