import {
  type Codec,
  followedBy,
  located,
  prefixed,
  repeat,
  transform,
  tuple,
} from "@uncutsql/codec";
import { identifier } from "../identifier.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression, FunctionCall } from "./types.ts";

/** Commit only after the opening parenthesis, so bare names remain column references. */
export const functionCall = (expression: Codec<Expression>): Codec<FunctionCall> =>
  located(
    "FunctionCall",
    transform(
      tuple([
        identifier,
        prefixed(
          punctuation("("),
          followedBy(repeat(expression, { separator: punctuation(",", ", ") }), punctuation(")")),
        ),
      ]),
      {
        decode: ([name, args]): FunctionCall => ({ _tag: "FunctionCall", name, arguments: args }),
        encode: (value: FunctionCall) => [value.name, value.arguments] as const,
      },
    ),
  );
