import { Effect, Result } from "effect";
import { type Codec, EncodeError, make, parseError, prefixed, transform } from "@uncutsql/codec";
import { mergeErrors } from "@uncutsql/codec";
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
    case "RowValueExpression":
      return value.values.every(isConstant);
    case "PatternExpression":
      return (
        isConstant(value.left) &&
        isConstant(value.right) &&
        (value.escape === undefined || isConstant(value.escape))
      );
    case "CaseExpression":
      return (
        (value.base === undefined || isConstant(value.base)) &&
        value.branches.every(
          (branch) => isConstant(branch.condition) && isConstant(branch.result),
        ) &&
        (value.else === undefined || isConstant(value.else))
      );
    case "InExpression":
      return isConstant(value.operand) && value.values.every(isConstant);
    case "BetweenExpression":
      return isConstant(value.operand) && isConstant(value.lower) && isConstant(value.upper);
    case "FunctionCall":
      return (
        value.arguments.every(isConstant) &&
        (value.orderBy === undefined ||
          value.orderBy.every((term) => isConstant(term.expression))) &&
        (value.filter === undefined || isConstant(value.filter))
      );
    case "RaiseExpression":
    case "BindParameter":
    case "ColumnReference":
      return false;
    case "CastExpression":
    case "CollateExpression":
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
              parseError(
                cursor,
                "constant default expression without column references, parameters or RAISE",
                true,
              ),
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
        new EncodeError({
          message: "A DEFAULT expression cannot contain column references, parameters or RAISE",
        }),
      );
    }
    if (
      value._tag === "UnaryExpression" &&
      (value.operator === "+" || value.operator === "-") &&
      value.operand._tag === "NumericLiteral"
    ) {
      return signedNumber.encode({ ...value, operator: value.operator, operand: value.operand });
    }
    return value._tag === "RowValueExpression" ||
      value._tag === "PatternExpression" ||
      value._tag === "CaseExpression" ||
      value._tag === "CastExpression" ||
      value._tag === "CollateExpression" ||
      value._tag === "InExpression" ||
      value._tag === "BetweenExpression" ||
      value._tag === "FunctionCall" ||
      value._tag === "BinaryExpression" ||
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
