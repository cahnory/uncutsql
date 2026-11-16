import type { Codec } from "../../../codec/index.ts";
import type { LiteralValue } from "../literal-value.ts";
import type { BinaryOperator, UnaryOperator } from "./operators.ts";

export interface ColumnReference {
  readonly _tag: "ColumnReference";
  /** column, table.column, or schema.table.column, in source order. */
  readonly parts: readonly [string] | readonly [string, string] | readonly [string, string, string];
}

export interface UnaryExpression {
  readonly _tag: "UnaryExpression";
  readonly operator: UnaryOperator;
  readonly operand: Expression;
}

export interface BinaryExpression {
  readonly _tag: "BinaryExpression";
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface NullTestExpression {
  readonly _tag: "NullTestExpression";
  readonly operator: "ISNULL" | "NOTNULL";
  readonly operand: Expression;
}

/** Parentheses affect tree shape and source spans, not semantic node kinds. */
export type Expression =
  | LiteralValue
  | ColumnReference
  | UnaryExpression
  | BinaryExpression
  | NullTestExpression;

export type ExpressionAt = (minimumPrecedence: number) => Codec<Expression>;
