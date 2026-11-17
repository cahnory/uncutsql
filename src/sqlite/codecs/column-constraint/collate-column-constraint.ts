import { prefixed, transform } from "../../../codec/index.ts";
import { keyword } from "../../operators/keyword.ts";
import { identifier } from "../identifier.ts";

export interface CollateColumnConstraint {
  readonly _tag: "Collate";
  readonly collation: string;
}

export const collateColumnConstraint = transform(prefixed(keyword("COLLATE"), identifier, " "), {
  decode: (collation): CollateColumnConstraint => ({ _tag: "Collate", collation }),
  encode: (value: CollateColumnConstraint) => value.collation,
});
