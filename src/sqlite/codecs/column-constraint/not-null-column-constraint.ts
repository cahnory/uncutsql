import { prefixed } from "../../../codec/index.ts";
import { keyword } from "../../operators/keyword.ts";
import { conflictColumnConstraint } from "./conflict-column-constraint.ts";

export const notNullColumnConstraint = conflictColumnConstraint(
  "NotNull",
  prefixed(keyword("NOT"), keyword("NULL"), " "),
);
