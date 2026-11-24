import { Effect } from "effect";

import { make, repeat, taggedUnion, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { lexeme } from "../../operators/lexeme.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { query } from "../query/query.ts";
import type { Expression } from "./types.ts";

/** A single item groups an expression; two or more form a row value. */
export const parenthesizedExpression = (expression: Codec<Expression>): Codec<Expression> => {
  const items = parenthesized(
    taggedUnion({
      Query: transform(query(expression), {
        decode: (query) => ({ _tag: "Query" as const, query }),
        encode: (value) => value.query,
      }),
      Items: transform(repeat(expression, { min: 1, separator: punctuation(",", ", ") }), {
        decode: (values) => ({ _tag: "Items" as const, values }),
        encode: (value) => value.values,
      }),
    }),
  );
  return lexeme(
    make<Expression>({
      decode: (cursor) =>
        Effect.map(items.decode(cursor), (result) => {
          const value: Expression =
            result.value._tag === "Query"
              ? { _tag: "SubqueryExpression", query: result.value.query }
              : result.value.values.length === 1
                ? result.value.values[0]!
                : { _tag: "RowValueExpression", values: result.value.values };
          const kind =
            result.value._tag === "Query"
              ? "SubqueryExpression"
              : result.value.values.length === 1
                ? "ParenthesizedExpression"
                : "RowValueExpression";
          return {
            ...result,
            nodes: [
              {
                children: result.nodes,
                end: result.next.offset,
                kind,
                start: cursor.offset,
              },
            ],
            value,
          };
        }),
      encode: parenthesized(expression).encode,
    }),
  );
};
