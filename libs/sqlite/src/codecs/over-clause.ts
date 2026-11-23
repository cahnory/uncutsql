import {
  type Codec,
  optional,
  prefixed,
  repeat,
  struct,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import { keyword } from "../operators/keyword.ts";
import { keywordSequence } from "../operators/keyword-sequence.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { windowName } from "./window-name.ts";
import { orderingTerm } from "./ordering-term.ts";
import { windowFrame } from "./window-frame.ts";
import type { Expression, WindowDefinition, WindowReference } from "./expression/types.ts";

export const windowDefinition = (expression: Codec<Expression>): Codec<WindowDefinition> =>
  transform(
    parenthesized(
      struct(
        {
          base: optional(windowName),
          partitionBy: optional(
            prefixed(
              keywordSequence(["PARTITION", "BY"]),
              repeat(expression, { min: 1, separator: punctuation(",", ", ") }),
              " ",
            ),
          ),
          orderBy: optional(
            prefixed(
              keywordSequence(["ORDER", "BY"]),
              repeat(orderingTerm(expression), { min: 1, separator: punctuation(",", ", ") }),
              " ",
            ),
          ),
          frame: optional(windowFrame(expression)),
        },
        " ",
      ),
    ),
    {
      decode: ({ base, partitionBy, orderBy, frame }): WindowDefinition => ({
        _tag: "WindowDefinition",
        ...(base === undefined ? {} : { base }),
        ...(partitionBy === undefined ? {} : { partitionBy }),
        ...(orderBy === undefined ? {} : { orderBy }),
        ...(frame === undefined ? {} : { frame }),
      }),
      encode: (value: WindowDefinition) => ({
        base: value.base,
        partitionBy: value.partitionBy,
        orderBy: value.orderBy,
        frame: value.frame,
      }),
    },
  );

export const overClause = (expression: Codec<Expression>): Codec<WindowReference> =>
  prefixed(
    keyword("OVER"),
    taggedUnion({
      WindowDefinition: windowDefinition(expression),
      NamedWindow: transform(windowName, {
        decode: (name) => ({ _tag: "NamedWindow" as const, name }),
        encode: (value) => value.name,
      }),
    }),
    " ",
  );
