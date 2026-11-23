import {
  type Codec,
  located,
  optional,
  prefixed,
  repeat,
  struct,
  transform,
} from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { windowDefinition } from "../over-clause.ts";
import { windowName } from "../window-name.ts";
import type { Expression } from "../expression/types.ts";
import type { SelectCore } from "./types.ts";
import { resultColumn } from "./result-column.ts";
import { fromClause } from "./from-clause.ts";

export const selectCore = (
  expression: Codec<Expression>,
  schemaNames = false,
): Codec<SelectCore> => {
  const list = <A>(codec: Codec<A>) => repeat(codec, { min: 1, separator: punctuation(",", ", ") });
  const clause = <A>(words: readonly string[], codec: Codec<A>) =>
    optional(prefixed(keywordSequence(words), codec, " "));
  return located(
    "SelectCore",
    transform(
      prefixed(
        keyword("SELECT"),
        struct(
          {
            modifier: optional(keywordChoice(["DISTINCT", "ALL"])),
            columns: list(resultColumn(expression, schemaNames)),
            from: clause(["FROM"], fromClause(expression)),
            where: clause(["WHERE"], expression),
            groupBy: clause(["GROUP", "BY"], list(expression)),
            having: clause(["HAVING"], expression),
            windows: clause(
              ["WINDOW"],
              list(
                struct(
                  {
                    name: windowName,
                    definition: prefixed(keyword("AS"), windowDefinition(expression), " "),
                  },
                  " ",
                ),
              ),
            ),
          },
          " ",
        ),
        " ",
      ),
      {
        decode: ({ columns, modifier, from, where, groupBy, having, windows }): SelectCore => ({
          _tag: "SelectQuery",
          columns,
          ...(modifier === undefined ? {} : { modifier }),
          ...(from === undefined ? {} : { from }),
          ...(where === undefined ? {} : { where }),
          ...(groupBy === undefined ? {} : { groupBy }),
          ...(having === undefined ? {} : { having }),
          ...(windows === undefined ? {} : { windows }),
        }),
        encode: (value: SelectCore) => ({
          columns: value.columns,
          modifier: value.modifier,
          from: value.from,
          where: value.where,
          groupBy: value.groupBy,
          having: value.having,
          windows: value.windows,
        }),
      },
    ),
  );
};
