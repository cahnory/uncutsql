import type { Codec } from "@uncutsql/codec";
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

export interface InExpression {
  readonly _tag: "InExpression";
  readonly operator: "IN" | "NOT IN";
  readonly operand: Expression;
  readonly values: readonly Expression[];
}

export interface BetweenExpression {
  readonly _tag: "BetweenExpression";
  readonly operator: "BETWEEN" | "NOT BETWEEN";
  readonly operand: Expression;
  readonly lower: Expression;
  readonly upper: Expression;
}

export interface FunctionCall {
  readonly _tag: "FunctionCall";
  readonly name: string;
  readonly arguments: readonly Expression[];
}

/** Parentheses affect tree shape and source spans, not semantic node kinds. */
export type Expression =
  | InExpression
  | BetweenExpression
  | FunctionCall
  | LiteralValue
  | ColumnReference
  | UnaryExpression
  | BinaryExpression
  | NullTestExpression;

export type ExpressionAt = (minimumPrecedence: number) => Codec<Expression>;
