import { Effect, Result } from "effect";
import {
  type Codec,
  EncodeError,
  make,
  parseError,
  prefixed,
  transform,
} from "../../../codec/index.ts";
import { mergeErrors } from "../../../codec/model.ts";
import { keyword } from "../../operators/keyword.ts";
import { expression, type Expression } from "../expression.ts";
import { parenthesizedExpression } from "../expression/parenthesized-expression.ts";
import { literalValue } from "../literal-value.ts";
import { signedNumber } from "../signed-number.ts";

export interface DefaultColumnConstraint {
  readonly _tag: "Default";
  readonly value: Expression;
}

const isConstant = (value: Expression): boolean => {
  switch (value._tag) {
    case "ColumnReference":
      return false;
    case "NullTestExpression":
    case "UnaryExpression":
      return isConstant(value.operand);
    case "BinaryExpression":
      return isConstant(value.left) && isConstant(value.right);
    default:
      return true;
  }
};

const grouped = parenthesizedExpression(expression);
const defaultValue: Codec<Expression> = make<Expression>({
  decode: (cursor) =>
    Effect.gen(function* () {
      // DEFAULT 1 + 2 is invalid, while DEFAULT (1 + 2) is valid.
      const choices: readonly Pick<Codec<Expression>, "decode">[] = [
        grouped,
        signedNumber,
        literalValue,
      ];
      let best = parseError(cursor, "default value");
      for (const codec of choices) {
        const result = yield* Effect.result(codec.decode(cursor));
        if (Result.isSuccess(result)) {
          if (!isConstant(result.success.value)) {
            return yield* Effect.fail(
              parseError(cursor, "constant default expression without column references", true),
            );
          }
          return result.success;
        }
        if (result.failure.committed) return yield* Effect.fail(result.failure);
        best = mergeErrors(best, result.failure);
      }
      return yield* Effect.fail(best);
    }),
  encode: (value) => {
    if (!isConstant(value)) {
      return Effect.fail(
        new EncodeError({ message: "A DEFAULT expression cannot contain column references" }),
      );
    }
    if (
      value._tag === "UnaryExpression" &&
      (value.operator === "+" || value.operator === "-") &&
      value.operand._tag === "NumericLiteral"
    ) {
      return signedNumber.encode({ ...value, operator: value.operator, operand: value.operand });
    }
    return value._tag === "BinaryExpression" ||
      value._tag === "UnaryExpression" ||
      value._tag === "NullTestExpression"
      ? grouped.encode(value)
      : expression.encode(value);
  },
});

export const defaultColumnConstraint: Codec<DefaultColumnConstraint> = transform(
  prefixed(keyword("DEFAULT"), defaultValue, " "),
  {
    decode: (value): DefaultColumnConstraint => ({ _tag: "Default", value }),
    encode: (value: DefaultColumnConstraint) => value.value,
  },
);
