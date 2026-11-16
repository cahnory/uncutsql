import { transform } from "../../../codec/index.ts";
import { foreignKeyClause, type ForeignKeyClause } from "../foreign-key-clause.ts";

export interface ReferencesColumnConstraint {
  readonly _tag: "References";
  readonly references: ForeignKeyClause;
}

export const referencesColumnConstraint = transform(foreignKeyClause, {
  decode: (references): ReferencesColumnConstraint => ({ _tag: "References", references }),
  encode: (value: ReferencesColumnConstraint) => value.references,
});
