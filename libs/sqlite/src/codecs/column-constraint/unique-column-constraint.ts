import { keyword } from "../../operators/keyword.ts";
import { conflictColumnConstraint } from "./conflict-column-constraint.ts";

export const uniqueColumnConstraint = conflictColumnConstraint("Unique", keyword("UNIQUE"));
