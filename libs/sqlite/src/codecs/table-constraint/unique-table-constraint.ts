import { keyTableConstraint } from "./key-table-constraint.ts";

export const uniqueTableConstraint = keyTableConstraint("Unique", ["UNIQUE"]);
