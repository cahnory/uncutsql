import { Effect } from "effect";
import { type Value, EncodeError, ParseError } from "@uncutsql/codec";
import {
  createTable,
  diffSchemas,
  SchemaDiffError,
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

type _DiffRequirements = Assert<Equal<Effect.Services<ReturnType<typeof diffSchemas>>, never>>;
type _DiffErrors = Assert<
  Equal<Effect.Error<ReturnType<typeof diffSchemas>>, SchemaDiffError | EncodeError>
>;
