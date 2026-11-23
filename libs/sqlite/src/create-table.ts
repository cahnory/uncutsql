// Public entry points from the foundation; each grammar rule has its own module.
export {
  createTable,
  createTableGrammar,
  createTableStatement,
  createTableStatementGrammar,
} from "./codecs/create-table-statement.ts";
export type { CreateTable, CreateTableStatement } from "./codecs/create-table-statement.ts";
export { columnDefinition } from "./codecs/column-definition.ts";
export type { ColumnDefinition } from "./codecs/column-definition.ts";
export type { ColumnConstraint } from "./codecs/column-constraint.ts";
export { stringLiteral } from "./codecs/string-literal.ts";
export { literalValue } from "./codecs/literal-value.ts";
export type { LiteralValue } from "./codecs/literal-value.ts";

export type { CreateTableAs } from "./codecs/create-table-as.ts";
