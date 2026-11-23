import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { type SourceNode, EncodeError, ParseError, document } from "@uncutsql/codec";
import {
  type BinaryOperator,
  type Expression,
  type NumericLiteral,
  type UnaryOperator,
  blobLiteral,
  expression,
  numericLiteral,
  sqlExpression,
} from "../src/index.ts";
import { binaryPrecedence, unaryPrecedence } from "../src/codecs/expression/operators.ts";

const decode = (sql: string) => Effect.runSync(sqlExpression.decode(sql));
const encode = (value: Expression) => Effect.runSync(sqlExpression.encode(value));
const number = (value: string): NumericLiteral => ({ _tag: "NumericLiteral", value });
const binary = (operator: BinaryOperator, left: Expression, right: Expression): Expression => ({
  _tag: "BinaryExpression",
  operator,
  left,
  right,
});
const unary = (operator: UnaryOperator, operand: Expression): Expression => ({
  _tag: "UnaryExpression",
  operator,
  operand,
});
const column = (name: string): Expression => ({ _tag: "ColumnReference", parts: [name] });

const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const evaluate = (database: DatabaseSync, sql: string) => {
  const query = database.prepare(`SELECT (${sql}\n) AS value FROM t`);
  query.setReadBigInts(true);
  return query.get()!.value;
};

const openDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec('CREATE TABLE t (a, b, c, "TRUE"); INSERT INTO t VALUES (9, 4, 2, 7)');
  return database;
};

test("precedence and left associativity shape the semantic tree", () => {
  assert.deepEqual(
    decode("1 + 2 * 3"),
    binary("+", number("1"), binary("*", number("2"), number("3"))),
  );
  assert.deepEqual(
    decode("a - b - c"),
    binary("-", binary("-", column("a"), column("b")), column("c")),
  );
  assert.deepEqual(
    decode("NOT a = b AND c"),
    binary("AND", unary("NOT", binary("=", column("a"), column("b"))), column("c")),
  );
  assert.deepEqual(
    decode("1 | 2 << 3"),
    binary("<<", binary("|", number("1"), number("2")), number("3")),
  );
});

test("printing preserves right-nested expressions and avoids '--' comments", () => {
  for (const [source, expected] of [
    ["a - (b - c)", '"a" - ("b" - "c")'],
    ["a + (b + c)", '"a" + ("b" + "c")'],
    ["(a + b) * c", '("a" + "b") * "c"'],
    ["a / (b * c)", '"a" / ("b" * "c")'],
    ["-(-1)", "- -1"],
    ["-(1 + 2)", "-(1 + 2)"],
    ["(NOT a) = b", '(NOT "a") = "b"'],
    ["(((1)))", "1"],
  ]) {
    const ast = decode(source!);
    assert.equal(encode(ast), expected);
    assert.deepEqual(decode(encode(ast)), ast);
  }
});

for (const source of [
  "1 + 2 * 3",
  "(1 + 2) * 3",
  "9 - (4 - 2)",
  "9 / (4 * 2)",
  "9 / 4 / 2",
  "1 || 2 * 3",
  "1 + 2 << 3",
  "8 >> 1 & 3 | 2",
  "2 < 3 = 1",
  "2 = 3 < 1",
  "NOT 2 = 1",
  "1 = NOT 0",
  "NOT 0 OR 0 AND 0",
  "~1 + -2",
  "- -1",
  "NULL IS NULL",
  "NULL ISNULL",
  "a NOT NULL",
  "1 = NULL ISNULL",
  "NOT 1 ISNULL",
  "(NOT 1) ISNULL",
  "1 NOTNULL = 0",
  "NULL IS NOT NULL",
  "1 IS NOT DISTINCT FROM 1",
  "1 IS DISTINCT FROM NULL",
  "1 == 1",
  "1 <> 2",
  "a - (b - c)",
  "t.a + t.b * c",
  "9007199254740993",
  "9223372036854775807",
  "-9223372036854775808",
  "9223372036854775808",
  "0xffffffffffffffff",
  "0x8000000000000000",
  "0x00000000000000000001",
  "0xF_F",
  "1_234",
  "1_2.3_4e-0_1",
  ".5",
  "1.",
  "1.e2",
  "01",
  "1.0 / 2",
  "1 / 2",
  "X'00fF'",
  "X''",
  "'O''Brien' || '!'",
  "NULL",
  "FALSE",
  "TRUE IS TRUE",
  '"TRUE"',
  "1 /* gap */ + -- line\n2",
  "1 IS /* gap */ NOT DISTINCT FROM 1",
]) {
  test(`expression round trip and SQLite result: ${source}`, () => {
    const ast = decode(source);
    const canonical = encode(ast);
    assert.deepEqual(decode(canonical), ast);
    const database = openDatabase();
    try {
      assert.deepEqual(evaluate(database, canonical), evaluate(database, source));
    } finally {
      database.close();
    }
  });
}

test("every binary precedence pair retains both tree shape and SQLite evaluation", () => {
  const operators = Object.keys(binaryPrecedence) as BinaryOperator[];
  const database = openDatabase();
  // Independent oracle deliberately parenthesizes everything rather than using precedence.
  const explicit = (value: Expression): string => {
    switch (value._tag) {
      case "NumericLiteral":
        return value.value;
      case "UnaryExpression":
        return `(${value.operator} (${explicit(value.operand)}))`;
      case "BinaryExpression":
        return `(${explicit(value.left)} ${value.operator} ${explicit(value.right)})`;
      default:
        throw new Error("Unexpected generated node");
    }
  };
  const check = (ast: Expression) => {
    const sql = encode(ast);
    assert.deepEqual(decode(sql), ast, sql);
    assert.deepEqual(evaluate(database, sql), evaluate(database, explicit(ast)), sql);
  };
  try {
    for (const outer of operators) {
      for (const inner of operators) {
        check(binary(outer, binary(inner, number("9"), number("4")), number("2")));
        check(binary(outer, number("9"), binary(inner, number("4"), number("2"))));
      }
      for (const operator of Object.keys(unaryPrecedence) as UnaryOperator[]) {
        check(unary(operator, binary(outer, number("9"), number("4"))));
        check(binary(outer, unary(operator, number("9")), number("4")));
        check(binary(outer, number("9"), unary(operator, number("4"))));
      }
    }
  } finally {
    database.close();
  }
});

test("numeric spelling retains precision and INTEGER versus REAL behavior", () => {
  for (const value of ["9007199254740993", "1", "1.0", "1e0", "01", "0xFF", "1_000"]) {
    assert.deepEqual(decode(value), number(value));
    assert.equal(encode(number(value)), value);
  }
  const database = openDatabase();
  try {
    assert.equal(evaluate(database, encode(decode("1 / 2"))), 0n);
    assert.equal(evaluate(database, encode(decode("1.0 / 2"))), 0.5);
  } finally {
    database.close();
  }
});

test("qualified identifiers retain order, and quoted TRUE remains a column", () => {
  assert.deepEqual(decode('main."table".[column]'), {
    _tag: "ColumnReference",
    parts: ["main", "table", "column"],
  });
  assert.deepEqual(decode("true.x"), { _tag: "ColumnReference", parts: ["true", "x"] });
  assert.deepEqual(decode('"TRUE"'), { _tag: "ColumnReference", parts: ["TRUE"] });
  assert.deepEqual(decode("true"), { _tag: "KeywordLiteral", value: "TRUE" });
});

test("parentheses remain visible in the source map without polluting the AST", () => {
  const source = " a - (b - c) ";
  const parsed = Effect.runSync(sqlExpression.decodeWithSourceMap(source));
  const flatten = (nodes: readonly SourceNode[]): readonly SourceNode[] =>
    nodes.flatMap((node) => [node, ...flatten(node.children)]);
  const nodes = flatten(parsed.sourceMap);
  assert.equal(parsed.sourceMap[0]!.kind, "BinaryExpression");
  assert.deepEqual(
    nodes
      .filter((node) => node.kind === "ParenthesizedExpression")
      .map((node) => source.slice(node.start, node.end)),
    ["(b - c)"],
  );
  assert.equal(parsed.value._tag, "BinaryExpression");
});

test("malformed numeric/blob tokens and missing operands are committed failures", () => {
  for (const source of [
    "1e",
    "1e+",
    "1__2",
    "0x",
    "0xG",
    "0x10000000000000000",
    "1abc",
    "1.2.3",
    "X'0'",
    "X'GG'",
    "X'AB",
    "1 +",
    "NOT",
    "(1 + 2",
    "a.",
  ]) {
    const error = failure(sqlExpression.decode(source));
    assert.ok(error instanceof ParseError, source);
    assert.equal(error.committed, true, source);
  }
});

for (const source of ["", "()", "1 2", "a.b.c.d", "1;"]) {
  test(`unsupported or incomplete expression fails: ${source}`, () => {
    assert.ok(failure(sqlExpression.decode(source)) instanceof ParseError);
  });
}

test("encoders reject invalid numeric/blob payloads and operators", () => {
  for (const value of [
    "",
    "-1",
    "+1",
    "NaN",
    "Infinity",
    "1e",
    "1; DROP TABLE t",
    "0x10000000000000000",
  ]) {
    assert.ok(failure(numericLiteral.encode(number(value))) instanceof EncodeError);
  }
  for (const value of ["0", "GG", "00'", "00 FF"]) {
    assert.ok(failure(blobLiteral.encode({ _tag: "BlobLiteral", value })) instanceof EncodeError);
  }
  // @ts-expect-error Unknown operators must not silently alter a JS caller's AST.
  const invalid = binary("**", number("1"), number("2"));
  assert.ok(failure(expression.encode(invalid)) instanceof EncodeError);
});

test("expression effects can be reused and parsed concurrently", async () => {
  const inputs = ["a - (b - c)", "1 + 2 * 3", "NOT 1 = 2", "X'00'"];
  const values = await Effect.runPromise(
    Effect.all(inputs.map(sqlExpression.decode), { concurrency: "unbounded" }),
  );
  assert.deepEqual(values, inputs.map(decode));
  const repeated = document(expression).decode("1 + 2");
  assert.deepEqual(Effect.runSync(repeated), Effect.runSync(repeated));
});

test("function calls preserve nested arguments, precedence and SQLite results", () => {
  const database = openDatabase();
  try {
    for (const source of [
      "abs(-3) + 2 * length('hello')",
      "coalesce(NULL, abs(a - b), 0)",
      "round(1.25, 1)",
      "length /* comment */ (lower('ABC'))",
      "pi()",
      '"abs"(-2)',
    ]) {
      const ast = decode(source);
      const sql = encode(ast);
      assert.deepEqual(decode(sql), ast);
      assert.equal(evaluate(database, sql), evaluate(database, source));
    }
    assert.deepEqual(decode("custom()"), { _tag: "FunctionCall", name: "custom", arguments: [] });
    assert.equal(encode(decode("abs(-1)")), '"abs"(-1)');
  } finally {
    database.close();
  }
});

test("malformed calls commit after the opening parenthesis", () => {
  for (const sql of ["f(", "f(1,)", "f(,1)", "f(1 2)", "f(g(1)"]) {
    const error = failure(sqlExpression.decode(sql));
    assert.ok(error instanceof ParseError, sql);
    assert.equal(error.committed, true, sql);
  }
});

test("equality, BETWEEN, IN and null tests share SQLite's left-associative precedence", () => {
  const database = openDatabase();
  try {
    for (const source of [
      "2 BETWEEN 1 AND 2 = 1",
      "2 BETWEEN 1 AND 2 != 0",
      "0 = 1 ISNULL",
      "0 = 1 NOTNULL",
      "0 ISNULL = 1",
      "0 IN (0) = 1",
      "0 = 1 IN (0)",
      "2 BETWEEN 1 AND 2 IN (1)",
      "2 BETWEEN 1 AND (2 = 1)",
      "0 = (1 ISNULL)",
    ]) {
      const ast = decode(source);
      const sql = encode(ast);
      assert.deepEqual(decode(sql), ast, source);
      assert.deepEqual(evaluate(database, sql), evaluate(database, source), source);
    }
    assert.equal(decode("2 BETWEEN 1 AND 2 = 1")._tag, "BinaryExpression");
    assert.equal(decode("0 = 1 ISNULL")._tag, "NullTestExpression");
  } finally {
    database.close();
  }
});
