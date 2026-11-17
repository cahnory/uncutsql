import {
  type Codec,
  alternatives,
  optional,
  prefixed,
  struct,
  transform,
} from "../../../codec/index.ts";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { expression, type Expression } from "../expression.ts";

export interface GeneratedColumnConstraint {
  readonly _tag: "Generated";
  readonly expression: Expression;
  /** Omission means VIRTUAL in SQLite, but remains omitted in the AST. */
  readonly storage?: "VIRTUAL" | "STORED";
}

const prefix = alternatives(keywordSequence(["GENERATED", "ALWAYS", "AS"]), keyword("AS"));

export const generatedColumnConstraint: Codec<GeneratedColumnConstraint> = transform(
  prefixed(
    prefix,
    struct(
      {
        expression: parenthesized(expression),
        storage: optional(keywordChoice(["VIRTUAL", "STORED"])),
      },
      " ",
    ),
    " ",
  ),
  {
    decode: ({ expression, storage }): GeneratedColumnConstraint => ({
      _tag: "Generated",
      expression,
      ...(storage === undefined ? {} : { storage }),
    }),
    encode: (value: GeneratedColumnConstraint) => ({
      expression: value.expression,
      storage: value.storage,
    }),
  },
);
