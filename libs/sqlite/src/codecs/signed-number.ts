import { Effect } from "effect";

import { commit, EncodeError, located, make, parseError, read } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { lexeme } from "../operators/lexeme.ts";
import { unaryOperator } from "./expression/operators.ts";
import { numericLiteral } from "./numeric-literal.ts";
import type { NumericLiteral } from "./numeric-literal.ts";

export interface SignedNumber {
  readonly _tag: "UnaryExpression";
  readonly operand: NumericLiteral;
  readonly operator: "+" | "-";
}

/** DEFAULT allows a single sign before a numeric literal without parentheses. */
export const signedNumber: Codec<SignedNumber> = lexeme(
  located(
    "SignedNumber",
    make<SignedNumber>({
      decode: (cursor) =>
        Effect.gen(function* () {
          const operator = yield* unaryOperator.decode(cursor);
          if (operator.value !== "+" && operator.value !== "-") {
            return yield* Effect.fail(parseError(cursor, "+ or -"));
          }
          const number = yield* commit(numericLiteral).decode(operator.next);
          return read(
            { _tag: "UnaryExpression", operand: number.value, operator: operator.value },
            number.next,
            number.nodes,
          );
        }),
      encode: (value) => {
        if (value.operator !== "+" && value.operator !== "-") {
          return Effect.fail(
            new EncodeError({ message: "Expected '+' or '-' before a numeric literal" }),
          );
        }
        return Effect.map(
          numericLiteral.encode(value.operand),
          (number) => value.operator + number,
        );
      },
    }),
  ),
);
