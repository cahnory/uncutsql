import { optional, prefixed, struct, taggedUnion, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordChoice } from "../operators/keyword-choice.ts";
import { keyword } from "../operators/keyword.ts";
import type { Expression, FrameBoundary, WindowFrame } from "./expression/types.ts";

export const windowFrame = (expression: Codec<Expression>): Codec<WindowFrame> => {
  const boundary = (start: boolean): Codec<FrameBoundary> =>
    taggedUnion({
      SpecialBoundary: transform(
        keywordChoice(
          start ? ["UNBOUNDED PRECEDING", "CURRENT ROW"] : ["UNBOUNDED FOLLOWING", "CURRENT ROW"],
        ),
        {
          decode: (value) => ({ _tag: "SpecialBoundary" as const, value }),
          encode: (value) => value.value,
        },
      ),
      OffsetBoundary: transform(
        struct({ value: expression, direction: keywordChoice(["PRECEDING", "FOLLOWING"]) }, " "),
        {
          decode: (value) => ({ _tag: "OffsetBoundary" as const, ...value }),
          encode: (value) => value,
        },
      ),
    });
  const bounds = taggedUnion({
    BetweenBounds: transform(
      prefixed(
        keyword("BETWEEN"),
        struct(
          {
            start: boundary(true),
            end: prefixed(keyword("AND"), boundary(false), " "),
          },
          " ",
        ),
        " ",
      ),
      {
        decode: (value) => ({ _tag: "BetweenBounds" as const, ...value }),
        encode: (value) => value,
      },
    ),
    SingleBound: transform(boundary(true), {
      decode: (start) => ({ _tag: "SingleBound" as const, start }),
      encode: (value) => value.start,
    }),
  });
  return transform(
    struct(
      {
        unit: keywordChoice(["ROWS", "RANGE", "GROUPS"]),
        bounds,
        exclude: optional(
          prefixed(
            keyword("EXCLUDE"),
            keywordChoice(["NO OTHERS", "CURRENT ROW", "GROUP", "TIES"]),
            " ",
          ),
        ),
      },
      " ",
    ),
    {
      decode: ({ bounds, exclude, unit }): WindowFrame => ({
        start: bounds.start,
        unit,
        ...(bounds._tag === "BetweenBounds" ? { end: bounds.end } : {}),
        ...(exclude === undefined ? {} : { exclude }),
      }),
      encode: (value: WindowFrame) => ({
        bounds:
          value.end === undefined
            ? { _tag: "SingleBound" as const, start: value.start }
            : { _tag: "BetweenBounds" as const, end: value.end, start: value.start },
        exclude: value.exclude,
        unit: value.unit,
      }),
    },
  );
};
