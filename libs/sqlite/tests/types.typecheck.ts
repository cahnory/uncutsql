import { diffDatabases, SchemaDiffError } from "@uncutsql/core";
import { Effect } from "effect";
import { type Value, EncodeError, ParseError } from "@uncutsql/codec";
import {
  createTable,
  lowerMigration,
  encodeMigration,
  MigrationPlanError,
  literalValue,
  expression,
  sqlExpression,
  type Expression,
} from "../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<A extends true> = A;
type _SqlRequirements = Assert<
  Equal<Effect.Services<ReturnType<typeof createTable.decode>>, never>
>;
type _SqlErrors = Assert<Equal<Effect.Error<ReturnType<typeof createTable.decode>>, ParseError>>;
type _ExpressionValue = Assert<Equal<Value<typeof expression>, Expression>>;
type _ExpressionRequirements = Assert<
  Equal<Effect.Services<ReturnType<typeof sqlExpression.decode>>, never>
>;
type _ExpressionDecodeErrors = Assert<
  Equal<Effect.Error<ReturnType<typeof sqlExpression.decode>>, ParseError>
>;
type _ExpressionEncodeErrors = Assert<
  Equal<Effect.Error<ReturnType<typeof sqlExpression.encode>>, EncodeError>
>;

// @ts-expect-error Value is a string, not a number.
literalValue.encode({ _tag: "StringLiteral", value: 42 });
// @ts-expect-error Numeric SQL spelling is deliberately not a JavaScript number.
expression.encode({ _tag: "NumericLiteral", value: 42 });
// @ts-expect-error Only supported SQLite operators can be constructed.
expression.encode({ _tag: "UnaryExpression", operator: "!", operand: { _tag: "NullLiteral" } });

type _DiffRequirements = Assert<Equal<Effect.Services<ReturnType<typeof diffDatabases>>, never>>;
type _DiffErrors = Assert<Equal<Effect.Error<ReturnType<typeof diffDatabases>>, SchemaDiffError>>;

type _PlanRequirements = Assert<Equal<Effect.Services<ReturnType<typeof lowerMigration>>, never>>;
type _PlanErrors = Assert<
  Equal<
    Effect.Error<ReturnType<typeof lowerMigration>>,
    SchemaDiffError | EncodeError | MigrationPlanError
  >
>;
type _MigrationEncodeErrors = Assert<
  Equal<Effect.Error<ReturnType<typeof encodeMigration>>, EncodeError>
>;

// @ts-expect-error Diff orchestration is owned by the consumer, not exported by the dialect.
import { diffSchemas } from "../src/index.ts";
// @ts-expect-error Logical planning is owned by core, not exported by the dialect.
import { planMigration } from "../src/index.ts";

void diffSchemas;
void planMigration;
