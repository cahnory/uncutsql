import {
  followedBy,
  located,
  optional,
  prefixed,
  repeat,
  struct,
  transform,
} from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import type { CaseExpression, Expression } from "./types.ts";

export const caseExpression = (expression: Codec<Expression>): Codec<CaseExpression> => {
  const branch = prefixed(
    keyword("WHEN"),
    struct(
      {
        condition: expression,
        result: prefixed(keyword("THEN"), expression, " "),
      },
      " ",
    ),
    " ",
  );
  return located(
    "CaseExpression",
    transform(
      prefixed(
        keyword("CASE"),
        followedBy(
          struct(
            {
              base: optional(expression),
              branches: repeat(branch, { join: " ", min: 1 }),
              else: optional(prefixed(keyword("ELSE"), expression, " ")),
            },
            " ",
          ),
          keyword("END"),
          " ",
        ),
        " ",
      ),
      {
        decode: ({ base, branches, else: otherwise }): CaseExpression => ({
          _tag: "CaseExpression",
          branches,
          ...(base === undefined ? {} : { base }),
          ...(otherwise === undefined ? {} : { else: otherwise }),
        }),
        encode: (value: CaseExpression) => ({
          base: value.base,
          branches: value.branches,
          else: value.else,
        }),
      },
    ),
  );
};
