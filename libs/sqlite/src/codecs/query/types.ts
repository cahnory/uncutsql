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
  readonly expressions: readonly CommonTableExpression[];
  readonly recursive: boolean;
}

export interface CommonTableExpression {
  readonly columns?: readonly string[];
  readonly materialization?: "MATERIALIZED" | "NOT MATERIALIZED";
  readonly name: string;
  readonly query: Query;
}
export type QueryCore = ValuesQuery | SelectCore;
export type CompoundOperator = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";

export interface CompoundQuery {
  readonly _tag: "CompoundQuery";
  readonly head: QueryCore;
  readonly limit?: LimitClause;
  readonly orderBy?: readonly OrderingTerm[];
  readonly rest: readonly { readonly operator: CompoundOperator; readonly query: QueryCore }[];
}

export type ResultColumn =
  | { readonly _tag: "StarColumn" }
  | { readonly _tag: "TableStarColumn"; readonly table: string }
  | { readonly _tag: "ExpressionColumn"; readonly alias?: string; readonly expression: Expression };

export type IndexHint =
  | { readonly _tag: "IndexedBy"; readonly name: string }
  | { readonly _tag: "NotIndexed" };

export interface TableReferenceSource extends InTableTarget {
  readonly alias?: string;
  readonly indexHint?: IndexHint;
}

export interface SubquerySource {
  readonly _tag: "SubquerySource";
  readonly alias?: string;
  readonly query: Query;
}

export interface GroupedSource {
  readonly _tag: "GroupedSource";
  readonly alias?: string;
  readonly from: FromClause;
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
    readonly constraint?: JoinConstraint;
    readonly operator: JoinOperator;
    readonly right: TableSource;
  }[];
}
export type FromClause = readonly TableSource[] | JoinedSource;

export type LimitClause =
  | { readonly _tag: "CountLimit"; readonly count: Expression; readonly offset?: Expression }
  | { readonly _tag: "CommaLimit"; readonly count: Expression; readonly offset: Expression };

export interface SelectCore {
  readonly _tag: "SelectQuery";
  readonly columns: readonly ResultColumn[];
  readonly from?: FromClause;
  readonly groupBy?: readonly Expression[];
  readonly having?: Expression;
  readonly modifier?: "ALL" | "DISTINCT";
  readonly where?: Expression;
  readonly windows?: readonly { readonly definition: WindowDefinition; readonly name: string }[];
}

export interface SelectQuery extends SelectCore {
  readonly limit?: LimitClause;
  readonly orderBy?: readonly OrderingTerm[];
}
