import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { EncodeError } from "@uncutsql/codec";
import { schema, type Statement } from "../src/index.ts";
import { SchemaDiffError } from "@uncutsql/core";
import { diffSchemas } from "./workflow.ts";

const parse = (sql: string) => Effect.runSync(schema.decode(sql));
const diff = (before: string, after: string) =>
  Effect.runSync(diffSchemas(parse(before), parse(after)));

test("diff ignores formatting, table order, creation guards and table/column ASCII case", () => {
  const before =
    "create table Users (ID INTEGER PRIMARY KEY, name TEXT DEFAULT 'x'); CREATE TABLE b (x)";
  const after =
    "CREATE TABLE b (x); CREATE TABLE IF NOT EXISTS main.\"users\" (`id` INTEGER PRIMARY KEY, [name] TEXT DEFAULT 'x');";
  assert.deepEqual(diff(before, after), { changes: [] });
  assert.deepEqual(diff("", ""), { changes: [] });
  assert.deepEqual(diff("CREATE TEMP TABLE t (x)", "CREATE TABLE temp.t (x)"), { changes: [] });
});

test("table additions and removals carry definitions and never infer renames", () => {
  const result = diff("CREATE TABLE old (x)", "CREATE TABLE fresh (x)");
  assert.deepEqual(
    result.changes.map((change) => [change._tag, "table" in change && change.table]),
    [
      ["TableRemoved", { catalog: "main", name: "old" }],
      ["TableAdded", { catalog: "main", name: "fresh" }],
    ],
  );
  const added = result.changes[1]!;
  assert.equal(added._tag, "TableAdded");
  if (added._tag === "TableAdded") assert.equal(added.definition.columns[0]!.name, "x");
  assert.equal(diff("", "CREATE TABLE t (x)").changes[0]!._tag, "TableAdded");
  assert.equal(diff("CREATE TABLE t (x)", "").changes[0]!._tag, "TableRemoved");
});

test("table identities distinguish schemas, quoted dots and Unicode names", () => {
  const source =
    'CREATE TABLE main.t (x); CREATE TABLE temp.t (x); CREATE TABLE "a.b" (x); CREATE TABLE a.b (x); CREATE TABLE "Ä" (x); CREATE TABLE "ä" (x)';
  assert.equal(diff("", source).changes.length, 6);
  assert.equal(diff("CREATE TABLE main.t (x)", "CREATE TABLE temp.t (x)").changes.length, 2);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec('CREATE TABLE "Ä" (x); CREATE TABLE "ä" (x)');
    assert.throws(() => database.exec('CREATE TABLE "ä" (y)'), /already exists/);
  } finally {
    database.close();
  }
});

test("column additions, removals and edits are directional with ordered positions", () => {
  const result = diff(
    "CREATE TABLE t (a INTEGER DEFAULT 1, gone TEXT, same)",
    "CREATE TABLE t (a TEXT NOT NULL DEFAULT 2, added BLOB, same)",
  );
  const table = result.changes[0]!;
  assert.equal(table._tag, "TableChanged");
  if (table._tag !== "TableChanged") return;
  assert.deepEqual(
    table.changes.map((change) => change._tag),
    ["ColumnRemoved", "ColumnChanged", "ColumnAdded"],
  );
  const removed = table.changes[0]!;
  if (removed._tag === "ColumnRemoved") assert.equal(removed.position, 1);
  const edited = table.changes[1]!;
  if (edited._tag === "ColumnChanged") {
    assert.deepEqual(edited.fields, ["dataType", "constraints"]);
    assert.equal(edited.before.dataType, "INTEGER");
    assert.equal(edited.after.dataType, "TEXT");
  }
  const reverse = diff("CREATE TABLE t (a TEXT)", "CREATE TABLE t (a INTEGER)").changes[0]!;
  assert.equal(reverse._tag, "TableChanged");
});

test("column reorder compares shared names without reporting insertions as moves", () => {
  const reordered = diff("CREATE TABLE t (a, b, c)", "CREATE TABLE t (c, a, added, b)").changes[0]!;
  assert.equal(reordered._tag, "TableChanged");
  if (reordered._tag === "TableChanged")
    assert.deepEqual(reordered.changes.at(-1), {
      _tag: "ColumnOrderChanged",
      before: ["a", "b", "c"],
      after: ["c", "a", "b"],
    });
  const inserted = diff("CREATE TABLE t (a, b)", "CREATE TABLE t (a, added, b)").changes[0]!;
  if (inserted._tag === "TableChanged")
    assert.deepEqual(
      inserted.changes.map((item) => item._tag),
      ["ColumnAdded"],
    );
});

test("diff detects table constraints and effective option flags", () => {
  const result = diff(
    "CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT, CHECK(a > 0))",
    "CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT, UNIQUE(b)) STRICT",
  ).changes[0]!;
  assert.equal(result._tag, "TableChanged");
  if (result._tag === "TableChanged")
    assert.deepEqual(
      result.changes.map((item) => item._tag),
      ["TableConstraintsChanged", "TableOptionsChanged"],
    );
  assert.deepEqual(
    diff(
      "CREATE TABLE t (a INTEGER PRIMARY KEY) STRICT, WITHOUT ROWID",
      "CREATE TABLE t (a INTEGER PRIMARY KEY) WITHOUT ROWID, STRICT, STRICT",
    ),
    { changes: [] },
  );
});

test("constraint ordering and declared type spelling remain conservative", () => {
  const result = diff(
    "CREATE TABLE t (a DEFAULT 1 DEFAULT 2)",
    "CREATE TABLE t (a DEFAULT 2 DEFAULT 1)",
  ).changes[0]!;
  assert.equal(result._tag, "TableChanged");
  if (result._tag === "TableChanged") assert.equal(result.changes[0]!._tag, "ColumnChanged");
  assert.equal(diff("CREATE TABLE t (a INT)", "CREATE TABLE t (a INTEGER)").changes.length, 1);
  assert.equal(
    diff("CREATE TABLE t (a CUSTOM TYPE)", "CREATE TABLE t (a CUSTOM /* INT */ TYPE)").changes
      .length,
    1,
  );
});

test("ambiguous identities return structured diagnostics for both schema sides", () => {
  const result = Effect.runSync(
    Effect.result(
      diffSchemas(
        parse("CREATE TABLE t (a, A); CREATE TABLE main.T (x)"),
        parse("CREATE TEMP TABLE main.bad (x)"),
      ),
    ),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof SchemaDiffError);
  assert.deepEqual(
    result.failure.diagnostics.map((item) => [item.side, item.code]),
    [
      ["before", "DuplicateColumn"],
      ["before", "DuplicateTable"],
      ["after", "InvalidTemporarySchema"],
    ],
  );
  assert.equal(result.failure.diagnostics[0]!.column, "a");
});

test("diff validates added ASTs and compares constraints without object-property order dependence", () => {
  const after = parse("CREATE TABLE t (a DEFAULT 1)");
  const table = after[0]!;
  assert.equal(table._tag, "CreateTable");
  if (table._tag !== "CreateTable") throw new Error("Expected explicit table");
  const reordered: readonly Statement[] = [
    {
      ...table,
      columns: [
        {
          name: "a",
          typeName: undefined,
          constraints: [{ value: { value: "1", _tag: "NumericLiteral" }, _tag: "Default" }],
        },
      ],
    },
  ];
  assert.deepEqual(Effect.runSync(diffSchemas(after, reordered)), { changes: [] });
  const invalid = [{ ...table, columns: [] }];
  const result = Effect.runSync(Effect.result(diffSchemas([], invalid)));
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EncodeError);
  assert.equal(table.columns[0]!.constraints.length, 1);
});
