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
export type Query = ValuesQuery | SelectQuery | CompoundQuery;
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

export interface TableReferenceSource extends InTableTarget {
  readonly alias?: string;
}

export interface SubquerySource {
  readonly _tag: "SubquerySource";
  readonly query: Query;
  readonly alias?: string;
}

export type TableSource = TableReferenceSource | SubquerySource;

export type LimitClause =
  | { readonly _tag: "CountLimit"; readonly count: Expression; readonly offset?: Expression }
  | { readonly _tag: "CommaLimit"; readonly offset: Expression; readonly count: Expression };

export interface SelectCore {
  readonly _tag: "SelectQuery";
  readonly modifier?: "ALL" | "DISTINCT";
  readonly columns: readonly ResultColumn[];
  readonly from?: readonly TableSource[];
  readonly where?: Expression;
  readonly groupBy?: readonly Expression[];
  readonly having?: Expression;
  readonly windows?: readonly { readonly name: string; readonly definition: WindowDefinition }[];
}

export interface SelectQuery extends SelectCore {
  readonly orderBy?: readonly OrderingTerm[];
  readonly limit?: LimitClause;
}
