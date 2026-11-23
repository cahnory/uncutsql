export * from "./create-table.ts";
export { identifier, stringValue, columnType } from "./tokens.ts";
export type { ColumnType } from "./tokens.ts";
export { numericLiteral } from "./codecs/numeric-literal.ts";
export type { NumericLiteral } from "./codecs/numeric-literal.ts";
export { blobLiteral } from "./codecs/blob-literal.ts";
export type { BlobLiteral } from "./codecs/blob-literal.ts";
export type { StringLiteral } from "./codecs/string-literal.ts";
export type { NullLiteral } from "./codecs/null-literal.ts";
export type { KeywordLiteral } from "./codecs/keyword-literal.ts";
export { expression, sqlExpression } from "./codecs/expression.ts";
export type {
  Expression,
  FunctionCall,
  OrderingTerm,
  FrameBoundary,
  WindowFrame,
  WindowDefinition,
  WindowReference,
  BetweenExpression,
  InExpression,
  InTableExpression,
  InTableTarget,
  ColumnReference,
  UnaryExpression,
  BinaryExpression,
  NullTestExpression,
  CollateExpression,
  CastExpression,
  CaseExpression,
  PatternExpression,
  BindParameter,
  RowValueExpression,
  RaiseExpression,
  BinaryOperator,
  UnaryOperator,
} from "./codecs/expression.ts";
export { tableConstraint } from "./codecs/table-constraint.ts";
export type { TableConstraint } from "./codecs/table-constraint.ts";
export { foreignKeyClause } from "./codecs/foreign-key-clause.ts";
export type { ForeignKeyClause } from "./codecs/foreign-key-clause.ts";
export type { TableOption } from "./codecs/table-options.ts";
export type { GeneratedColumnConstraint } from "./codecs/column-constraint/generated-column-constraint.ts";
export { tableReference, type TableReference } from "./codecs/table-reference.ts";

export { schema, schemaGrammar, type Statement } from "./schema.ts";
export { lowerMigration, encodeMigration, MigrationPlanError } from "./migration.ts";
export type {
  MigrationPlan,
  MigrationOperation,
  MigrationDiagnostic,
  MigrationWarning,
} from "./migration.ts";

export type { RebuildTableOperation } from "./rebuild.ts";

export { toDatabaseSchema, fromDatabaseSchema } from "./database.ts";

export { dialect } from "./dialect.ts";
