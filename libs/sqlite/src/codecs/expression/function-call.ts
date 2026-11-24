import { Effect } from "effect";

import {
  EncodeError,
  located,
  make,
  optional,
  prefixed,
  repeat,
  struct,
  taggedUnion,
  transform,
  tuple,
} from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { keyword } from "../../operators/keyword.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { windowKeyword } from "../../operators/window-keyword.ts";
import { identifier } from "../identifier.ts";
import { orderingTerm } from "../ordering-term.ts";
import { overClause } from "../over-clause.ts";
import type { Expression, FunctionCall } from "./types.ts";

/** The opening parenthesis commits; bare names remain column references. */
export const functionCall = (expression: Codec<Expression>): Codec<FunctionCall> => {
  const args = taggedUnion({
    Star: transform(punctuation("*"), {
      decode: () => ({ _tag: "Star" as const }),
      encode: (_value: { readonly _tag: "Star" }) => undefined,
    }),
    Arguments: transform(
      struct(
        {
          modifier: optional(keywordChoice(["DISTINCT", "ALL"])),
          values: repeat(expression, { separator: punctuation(",", ", ") }),
          orderBy: optional(
            prefixed(
              keywordSequence(["ORDER", "BY"]),
              repeat(orderingTerm(expression), { min: 1, separator: punctuation(",", ", ") }),
              " ",
            ),
          ),
        },
        " ",
      ),
      { decode: (value) => ({ _tag: "Arguments" as const, ...value }), encode: (value) => value },
    ),
  });
  const syntax = tuple(
    [
      tuple([identifier, parenthesized(args)]),
      optional(
        prefixed(
          windowKeyword("FILTER"),
          parenthesized(prefixed(keyword("WHERE"), expression, " ")),
          " ",
        ),
      ),
      optional(overClause(expression)),
    ],
    " ",
  );
  const mapped = transform(syntax, {
    decode: ([[name, args], filter, over]): FunctionCall => ({
      _tag: "FunctionCall",
      arguments: args._tag === "Star" ? [] : args.values,
      name,
      ...(args._tag === "Star"
        ? { star: true as const }
        : {
            ...(args.modifier === undefined ? {} : { modifier: args.modifier }),
            ...(args.orderBy === undefined ? {} : { orderBy: args.orderBy }),
          }),
      ...(filter === undefined ? {} : { filter }),
      ...(over === undefined ? {} : { over }),
    }),
    encode: (value: FunctionCall) =>
      [
        [
          value.name,
          value.star
            ? { _tag: "Star" as const }
            : {
                _tag: "Arguments" as const,
                modifier: value.modifier,
                orderBy: value.orderBy,
                values: value.arguments,
              },
        ] as const,
        value.filter,
        value.over,
      ] as const,
  });
  return located(
    "FunctionCall",
    make<FunctionCall>({
      decode: mapped.decode,
      encode: (value) =>
        value.star &&
        (value.arguments.length > 0 || value.modifier !== undefined || value.orderBy !== undefined)
          ? Effect.fail(
              new EncodeError({
                message: "Star arguments cannot have values, a modifier or ORDER BY",
              }),
            )
          : mapped.encode(value),
    }),
  );
};
