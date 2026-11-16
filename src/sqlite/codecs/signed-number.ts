import { Effect } from "effect";
import {
  type Codec,
  EncodeError,
  commit,
  located,
  make,
  parseError,
  read,
} from "../../codec/index.ts";
import { lexeme } from "../operators/lexeme.ts";
import { numericLiteral, type NumericLiteral } from "./numeric-literal.ts";
import { unaryOperator } from "./expression/operators.ts";

export interface SignedNumber {
  readonly _tag: "UnaryExpression";
  readonly operator: "+" | "-";
  readonly operand: NumericLiteral;
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
            { _tag: "UnaryExpression", operator: operator.value, operand: number.value },
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
