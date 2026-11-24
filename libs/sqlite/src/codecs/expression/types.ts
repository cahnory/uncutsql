import type { Codec } from "@uncutsql/codec";

import type { LiteralValue } from "../literal-value.ts";
import type { Query } from "../query/types.ts";
import type { TableReference } from "../table-reference.ts";
import type { BinaryOperator, UnaryOperator } from "./operators.ts";

export interface ColumnReference {
  readonly _tag: "ColumnReference";
  /** column, table.column, or schema.table.column, in source order. */
  readonly parts: readonly [string] | readonly [string, string] | readonly [string, string, string];
}

export interface UnaryExpression {
  readonly _tag: "UnaryExpression";
  readonly operand: Expression;
  readonly operator: UnaryOperator;
}

export interface BinaryExpression {
  readonly _tag: "BinaryExpression";
  readonly left: Expression;
  readonly operator: BinaryOperator;
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
  readonly escape?: Expression;
  readonly left: Expression;
  readonly operator:
    | "LIKE"
    | "NOT LIKE"
    | "GLOB"
    | "NOT GLOB"
    | "REGEXP"
    | "NOT REGEXP"
    | "MATCH"
    | "NOT MATCH";
  readonly right: Expression;
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
  readonly collation: string;
  readonly operand: Expression;
}

export interface NullTestExpression {
  readonly _tag: "NullTestExpression";
  readonly operand: Expression;
  readonly operator: "ISNULL" | "NOTNULL";
}

export interface SubqueryExpression {
  readonly _tag: "SubqueryExpression";
  readonly query: Query;
}

export interface ExistsExpression {
  readonly _tag: "ExistsExpression";
  readonly query: Query;
}

export interface InQueryExpression {
  readonly _tag: "InQueryExpression";
  readonly operand: Expression;
  readonly operator: "IN" | "NOT IN";
  readonly query: Query;
}

export interface InTableTarget {
  /** Absent for a table, present (possibly empty) for a table-valued function. */
  readonly arguments?: readonly Expression[];
  readonly table: TableReference;
}

export interface InTableExpression {
  readonly _tag: "InTableExpression";
  readonly operand: Expression;
  readonly operator: "IN" | "NOT IN";
  readonly target: InTableTarget;
}

export interface InExpression {
  readonly _tag: "InExpression";
  readonly operand: Expression;
  readonly operator: "IN" | "NOT IN";
  readonly values: readonly Expression[];
}

export interface BetweenExpression {
  readonly _tag: "BetweenExpression";
  readonly lower: Expression;
  readonly operand: Expression;
  readonly operator: "BETWEEN" | "NOT BETWEEN";
  readonly upper: Expression;
}

export interface OrderingTerm {
  readonly direction?: "ASC" | "DESC";
  readonly expression: Expression;
  readonly nulls?: "FIRST" | "LAST";
}

export type FrameBoundary =
  | {
      readonly _tag: "SpecialBoundary";
      readonly value: "UNBOUNDED PRECEDING" | "UNBOUNDED FOLLOWING" | "CURRENT ROW";
    }
  | {
      readonly _tag: "OffsetBoundary";
      readonly direction: "PRECEDING" | "FOLLOWING";
      readonly value: Expression;
    };

export interface WindowFrame {
  readonly end?: FrameBoundary;
  readonly exclude?: "NO OTHERS" | "CURRENT ROW" | "GROUP" | "TIES";
  readonly start: FrameBoundary;
  readonly unit: "ROWS" | "RANGE" | "GROUPS";
}

export interface WindowDefinition {
  readonly _tag: "WindowDefinition";
  /** Original identifier token, including quotes: SQLite window lookup preserves them. */
  readonly base?: string;
  readonly frame?: WindowFrame;
  readonly orderBy?: readonly OrderingTerm[];
  readonly partitionBy?: readonly Expression[];
}

/** Named-window names retain their original identifier token, including quotes. */
export type WindowReference =
  | WindowDefinition
  | { readonly _tag: "NamedWindow"; readonly name: string };

export interface FunctionCall {
  readonly _tag: "FunctionCall";
  readonly arguments: readonly Expression[];
  readonly filter?: Expression;
  readonly modifier?: "DISTINCT" | "ALL";
  readonly name: string;
  readonly orderBy?: readonly OrderingTerm[];
  readonly over?: WindowReference;
  readonly star?: true;
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
  | InTableExpression
  | InQueryExpression
  | SubqueryExpression
  | ExistsExpression
  | BetweenExpression
  | FunctionCall
  | LiteralValue
  | ColumnReference
  | UnaryExpression
  | BinaryExpression
  | NullTestExpression;

export type ExpressionAt = (minimumPrecedence: number) => Codec<Expression>;
