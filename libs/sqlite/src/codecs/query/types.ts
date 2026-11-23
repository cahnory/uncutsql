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
export type Query = ValuesQuery | SelectQuery;

export type ResultColumn =
  | { readonly _tag: "StarColumn" }
  | { readonly _tag: "TableStarColumn"; readonly table: string }
  | { readonly _tag: "ExpressionColumn"; readonly expression: Expression; readonly alias?: string };

export interface TableSource extends InTableTarget {
  readonly alias?: string;
}

export type LimitClause =
  | { readonly _tag: "CountLimit"; readonly count: Expression; readonly offset?: Expression }
  | { readonly _tag: "CommaLimit"; readonly offset: Expression; readonly count: Expression };

export interface SelectQuery {
  readonly _tag: "SelectQuery";
  readonly modifier?: "ALL" | "DISTINCT";
  readonly columns: readonly ResultColumn[];
  readonly from?: readonly TableSource[];
  readonly where?: Expression;
  readonly groupBy?: readonly Expression[];
  readonly having?: Expression;
  readonly windows?: readonly { readonly name: string; readonly definition: WindowDefinition }[];
  readonly orderBy?: readonly OrderingTerm[];
  readonly limit?: LimitClause;
}
