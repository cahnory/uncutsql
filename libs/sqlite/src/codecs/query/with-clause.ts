import { optional, prefixed, repeat, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { commonTableExpression } from "./common-table-expression.ts";
import type { Query, WithClause } from "./types.ts";

export const withClause = (query: Codec<Query>): Codec<WithClause> =>
  transform(
    prefixed(
      keyword("WITH"),
      struct(
        {
          recursive: optional(
            transform(keyword("RECURSIVE"), {
              decode: () => true as const,
              encode: (_value: true) => undefined,
            }),
          ),
          expressions: repeat(commonTableExpression(query), {
            min: 1,
            separator: punctuation(",", ", "),
          }),
        },
        " ",
      ),
      " ",
    ),
    {
      decode: ({ expressions, recursive }): WithClause => ({
        expressions,
        recursive: recursive ?? false,
      }),
      encode: (value: WithClause) => ({
        expressions: value.expressions,
        recursive: value.recursive ? (true as const) : undefined,
      }),
    },
  );
