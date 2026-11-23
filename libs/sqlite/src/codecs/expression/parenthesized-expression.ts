import { Effect } from "effect";
import { type Codec, make, repeat } from "@uncutsql/codec";
import { lexeme } from "../../operators/lexeme.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression } from "./types.ts";

/** A single item groups an expression; two or more form a row value. */
export const parenthesizedExpression = (expression: Codec<Expression>): Codec<Expression> => {
  const items = parenthesized(repeat(expression, { min: 1, separator: punctuation(",", ", ") }));
  return lexeme(
    make<Expression>({
      decode: (cursor) =>
        Effect.map(items.decode(cursor), (result) => {
          const grouped = result.value.length === 1;
          return {
            ...result,
            value: grouped
              ? result.value[0]!
              : { _tag: "RowValueExpression" as const, values: result.value },
            nodes: [
              {
                kind: grouped ? "ParenthesizedExpression" : "RowValueExpression",
                start: cursor.offset,
                end: result.next.offset,
                children: result.nodes,
              },
            ],
          };
        }),
      encode: parenthesized(expression).encode,
    }),
  );
};
