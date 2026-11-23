import { Effect } from "effect";
import {
  type Codec,
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
import { identifier } from "../identifier.ts";
import { overClause } from "../over-clause.ts";
import { orderingTerm } from "../ordering-term.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
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
          keyword("FILTER"),
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
      name,
      arguments: args._tag === "Star" ? [] : args.values,
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
                values: value.arguments,
                orderBy: value.orderBy,
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
