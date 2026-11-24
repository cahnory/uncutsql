import { Effect } from "effect";

import { located, make, optional, prefixed, repeat, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { keyword } from "../../operators/keyword.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { windowKeyword } from "../../operators/window-keyword.ts";
import type { Expression } from "../expression/types.ts";
import { windowDefinition } from "../over-clause.ts";
import { windowName, windowNameAfterKeyword } from "../window-name.ts";
import { fromClause } from "./from-clause.ts";
import { resultColumn } from "./result-column.ts";
import type { SelectCore } from "./types.ts";

export const selectCore = (
  expression: Codec<Expression>,
  schemaNames = false,
): Codec<SelectCore> => {
  const list = <A>(codec: Codec<A>) => repeat(codec, { min: 1, separator: punctuation(",", ", ") });
  const clause = <A>(words: readonly string[], codec: Codec<A>) =>
    optional(prefixed(keywordSequence(words), codec, " "));
  const declarations = list(
    struct(
      { name: windowName, definition: prefixed(keyword("AS"), windowDefinition(expression), " ") },
      " ",
    ),
  );
  const windows = make<NonNullable<SelectCore["windows"]>>({
    decode: declarations.decode,
    encode: (values) =>
      Effect.gen(function* () {
        if (values[0]) {
          yield* windowNameAfterKeyword.encode(values[0].name);
        }
        return yield* declarations.encode(values);
      }),
  });
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
            windows: optional(prefixed(windowKeyword("WINDOW"), windows, " ")),
          },
          " ",
        ),
        " ",
      ),
      {
        decode: ({ columns, from, groupBy, having, modifier, where, windows }): SelectCore => ({
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
          from: value.from,
          groupBy: value.groupBy,
          having: value.having,
          modifier: value.modifier,
          where: value.where,
          windows: value.windows,
        }),
      },
    ),
  );
};
