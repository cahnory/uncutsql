export * from "./create-table.ts";
export { columnType, identifier, stringValue } from "./tokens.ts";
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
  BetweenExpression,
  BinaryExpression,
  BinaryOperator,
  BindParameter,
  CaseExpression,
  CastExpression,
  CollateExpression,
  ColumnReference,
  ExistsExpression,
  Expression,
  FrameBoundary,
  FunctionCall,
  InExpression,
  InQueryExpression,
  InTableExpression,
  InTableTarget,
  NullTestExpression,
  OrderingTerm,
  PatternExpression,
  RaiseExpression,
  RowValueExpression,
  SubqueryExpression,
  UnaryExpression,
  UnaryOperator,
  WindowDefinition,
  WindowFrame,
  WindowReference,
} from "./codecs/expression.ts";
export { tableConstraint } from "./codecs/table-constraint.ts";
export type { TableConstraint } from "./codecs/table-constraint.ts";
export { foreignKeyClause } from "./codecs/foreign-key-clause.ts";
export type { ForeignKeyClause } from "./codecs/foreign-key-clause.ts";
export type { TableOption } from "./codecs/table-options.ts";
export type { GeneratedColumnConstraint } from "./codecs/column-constraint/generated-column-constraint.ts";
export { tableReference } from "./codecs/table-reference.ts";
export type { TableReference } from "./codecs/table-reference.ts";

export { schema, schemaGrammar } from "./schema.ts";
export type { Statement } from "./schema.ts";
export { encodeMigration, lowerMigration, MigrationPlanError } from "./migration.ts";
export type {
  MigrationDiagnostic,
  MigrationOperation,
  MigrationPlan,
  MigrationWarning,
} from "./migration.ts";

export type { RebuildTableOperation } from "./rebuild.ts";

export { fromDatabaseSchema, toDatabaseSchema } from "./database.ts";

export { dialect } from "./dialect.ts";

export { queryGrammar, sqlQuery } from "./query.ts";
export type {
  CommonTableExpression,
  CompoundOperator,
  CompoundQuery,
  FromClause,
  GroupedSource,
  IndexHint,
  JoinConstraint,
  JoinedSource,
  JoinModifier,
  JoinOperator,
  LimitClause,
  Query,
  QueryBody,
  QueryCore,
  ResultColumn,
  SelectCore,
  SelectQuery,
  SubquerySource,
  TableReferenceSource,
  TableSource,
  ValuesQuery,
  WithClause,
} from "./query.ts";

export { createIndex } from "./codecs/create-index.ts";
export type { CreateIndex, IndexTerm } from "./codecs/create-index.ts";
export { createTrigger } from "./codecs/create-trigger.ts";
export type { CreateTrigger } from "./codecs/create-trigger.ts";
export type { TriggerAction } from "./codecs/trigger-action.ts";
export { createView } from "./codecs/create-view.ts";
export type { CreateView } from "./codecs/create-view.ts";
