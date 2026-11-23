import type { Expression } from "../expression/types.ts";

export interface ValuesQuery {
  readonly _tag: "ValuesQuery";
  readonly rows: readonly (readonly Expression[])[];
}

/** Query syntax is separate from schema declarations and schema lowering. */
export type Query = ValuesQuery;
