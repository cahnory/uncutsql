// SQLite uses the same CHECK expression syntax at column and table level.
export { checkColumnConstraint as checkTableConstraint } from "../column-constraint/check-column-constraint.ts";
