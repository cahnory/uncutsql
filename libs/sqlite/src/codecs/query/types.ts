import type {
  Expression,
  InTableTarget,
  OrderingTerm,
  WindowDefinition,
} from "../expression/types.ts";

export interface ValuesQuery {
  readonly _tag: "ValuesQuery";
  readonly rows: readonly (readonly Expression[])[];
}

/** Query syntax is separate from schema declarations and schema lowering. */
export type QueryBody = ValuesQuery | SelectQuery | CompoundQuery;
export type Query = QueryBody & { readonly with?: WithClause };

export interface WithClause {
  readonly recursive: boolean;
  readonly expressions: readonly CommonTableExpression[];
}

export interface CommonTableExpression {
  readonly name: string;
  readonly columns?: readonly string[];
  readonly materialization?: "MATERIALIZED" | "NOT MATERIALIZED";
  readonly query: Query;
}
export type QueryCore = ValuesQuery | SelectCore;
export type CompoundOperator = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";

export interface CompoundQuery {
  readonly _tag: "CompoundQuery";
  readonly head: QueryCore;
  readonly rest: readonly { readonly operator: CompoundOperator; readonly query: QueryCore }[];
  readonly orderBy?: readonly OrderingTerm[];
  readonly limit?: LimitClause;
}

export type ResultColumn =
  | { readonly _tag: "StarColumn" }
  | { readonly _tag: "TableStarColumn"; readonly table: string }
  | { readonly _tag: "ExpressionColumn"; readonly expression: Expression; readonly alias?: string };

export type IndexHint =
  | { readonly _tag: "IndexedBy"; readonly name: string }
  | { readonly _tag: "NotIndexed" };

export interface TableReferenceSource extends InTableTarget {
  readonly indexHint?: IndexHint;
  readonly alias?: string;
}

export interface SubquerySource {
  readonly _tag: "SubquerySource";
  readonly query: Query;
  readonly alias?: string;
}

export interface GroupedSource {
  readonly _tag: "GroupedSource";
  readonly from: FromClause;
  readonly alias?: string;
}

export type TableSource = TableReferenceSource | SubquerySource | GroupedSource;

export type JoinModifier = "NATURAL" | "LEFT" | "RIGHT" | "FULL" | "OUTER" | "INNER" | "CROSS";
export type JoinOperator =
  | { readonly _tag: "CommaJoin" }
  | { readonly _tag: "KeywordJoin"; readonly modifiers: readonly JoinModifier[] };
export type JoinConstraint =
  | { readonly _tag: "On"; readonly expression: Expression }
  | { readonly _tag: "Using"; readonly columns: readonly string[] };
export interface JoinedSource {
  readonly _tag: "JoinedSource";
  readonly head: TableSource;
  readonly joins: readonly {
    readonly operator: JoinOperator;
    readonly right: TableSource;
    readonly constraint?: JoinConstraint;
  }[];
}
export type FromClause = readonly TableSource[] | JoinedSource;

export type LimitClause =
  | { readonly _tag: "CountLimit"; readonly count: Expression; readonly offset?: Expression }
  | { readonly _tag: "CommaLimit"; readonly offset: Expression; readonly count: Expression };

export interface SelectCore {
  readonly _tag: "SelectQuery";
  readonly modifier?: "ALL" | "DISTINCT";
  readonly columns: readonly ResultColumn[];
  readonly from?: FromClause;
  readonly where?: Expression;
  readonly groupBy?: readonly Expression[];
  readonly having?: Expression;
  readonly windows?: readonly { readonly name: string; readonly definition: WindowDefinition }[];
}

export interface SelectQuery extends SelectCore {
  readonly orderBy?: readonly OrderingTerm[];
  readonly limit?: LimitClause;
}
