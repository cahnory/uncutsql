import { type Codec, optional, prefixed, repeat, struct, transform } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { identifier } from "../identifier.ts";
import type { CommonTableExpression, Query } from "./types.ts";

export const commonTableExpression = (query: Codec<Query>): Codec<CommonTableExpression> =>
  transform(
    struct(
      {
        name: identifier,
        columns: optional(
          parenthesized(repeat(identifier, { min: 1, separator: punctuation(",", ", ") })),
        ),
        definition: prefixed(
          keyword("AS"),
          struct(
            {
              materialization: optional(keywordChoice(["NOT MATERIALIZED", "MATERIALIZED"])),
              query: parenthesized(query),
            },
            " ",
          ),
          " ",
        ),
      },
      " ",
    ),
    {
      decode: ({ name, columns, definition }): CommonTableExpression => ({
        name,
        query: definition.query,
        ...(columns === undefined ? {} : { columns }),
        ...(definition.materialization === undefined
          ? {}
          : { materialization: definition.materialization }),
      }),
      encode: (value: CommonTableExpression) => ({
        name: value.name,
        columns: value.columns,
        definition: { materialization: value.materialization, query: value.query },
      }),
    },
  );
