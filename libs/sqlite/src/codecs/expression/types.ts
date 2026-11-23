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

export type RaiseExpression =
  | { readonly _tag: "RaiseExpression"; readonly action: "IGNORE"; readonly message?: never }
  | {
      readonly _tag: "RaiseExpression";
      readonly action: "ROLLBACK" | "ABORT" | "FAIL";
      readonly message: Expression;
    };

export interface RowValueExpression {
  readonly _tag: "RowValueExpression";
  readonly values: readonly Expression[];
}

export interface BindParameter {
  readonly _tag: "BindParameter";
  readonly value: string;
}

export interface PatternExpression {
  readonly _tag: "PatternExpression";
  readonly operator:
    | "LIKE"
    | "NOT LIKE"
    | "GLOB"
    | "NOT GLOB"
    | "REGEXP"
    | "NOT REGEXP"
    | "MATCH"
    | "NOT MATCH";
  readonly left: Expression;
  readonly right: Expression;
  readonly escape?: Expression;
}

export interface CaseExpression {
  readonly _tag: "CaseExpression";
  readonly base?: Expression;
  readonly branches: readonly { readonly condition: Expression; readonly result: Expression }[];
  readonly else?: Expression;
}

export interface CastExpression {
  readonly _tag: "CastExpression";
  readonly operand: Expression;
  readonly typeName: string;
}

export interface CollateExpression {
  readonly _tag: "CollateExpression";
  readonly operand: Expression;
  readonly collation: string;
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
  | RaiseExpression
  | RowValueExpression
  | BindParameter
  | PatternExpression
  | CaseExpression
  | CastExpression
  | CollateExpression
  | InExpression
  | BetweenExpression
  | FunctionCall
  | LiteralValue
  | ColumnReference
  | UnaryExpression
  | BinaryExpression
  | NullTestExpression;

export type ExpressionAt = (minimumPrecedence: number) => Codec<Expression>;
