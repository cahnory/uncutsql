import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import {
  diffDatabases,
  planDatabaseMigration,
  SchemaDiffError,
  type DatabaseSchema,
  type DatabaseTable,
  type DatabaseColumn,
} from "../src/index.ts";

const column = (key: string, dataType = "integer"): DatabaseColumn => ({
  key,
  name: key,
  dataType,
  constraints: [],
});
const table = (
  name: string,
  columns: readonly DatabaseColumn[] = [column("id")],
): DatabaseTable => ({
  identity: { catalog: "app", schema: "public", name },
  name,
  columns,
  constraints: [],
  options: {},
});
const database = (...tables: DatabaseTable[]): DatabaseSchema => ({ tables });
const diff = (before: DatabaseSchema, after: DatabaseSchema) =>
  Effect.runSync(diffDatabases(before, after));

test("core compares normalized models without a SQL parser or dialect dependency", () => {
  const before = database(table("users"));
  const after = database(table("users", [column("id"), column("email", "varchar")]));
  const result = diff(before, after);
  const change = result.changes[0]!;
  assert.equal(change._tag, "TableChanged");
  if (change._tag === "TableChanged")
    assert.deepEqual(change.changes, [
      { _tag: "ColumnAdded", column: column("email", "varchar"), position: 1 },
    ]);
  const procedures = planDatabaseMigration(result).procedures;
  assert.equal(procedures[0]!._tag, "AlterTable");
  if (procedures[0]!._tag === "AlterTable") assert.deepEqual(procedures[0]!.after, after.tables[0]);
});

test("identity normalization belongs to adapters, including case and catalog/schema placement", () => {
  assert.deepEqual(
    diff(database(table("Foo")), database(table("foo"))).changes.map((item) => item._tag),
    ["TableRemoved", "TableAdded"],
  );
  const original = table("users");
  const differentCatalog = {
    ...original,
    identity: { catalog: "other", schema: "public", name: "users" },
  };
  const differentSchema = {
    ...original,
    identity: { catalog: "app", schema: "private", name: "users" },
  };
  assert.equal(diff(database(original), database(differentCatalog)).changes.length, 2);
  assert.equal(diff(database(original), database(differentSchema)).changes.length, 2);
  const providedKey = { ...column("id"), name: "ID" };
  assert.deepEqual(diff(database(table("t")), database(table("t", [providedKey]))), {
    changes: [],
  });
});

test("structured types, constraints and dialect extensions compare by value rather than object order", () => {
  const before: DatabaseTable = {
    ...table("t"),
    columns: [{ ...column("id"), dataType: { name: "decimal", parameters: [10, 2] } }],
    constraints: [
      { kind: "Unique", properties: { name: "key", columns: ["id"], "vendor:deferrable": true } },
    ],
    options: { "vendor:partition": { method: "hash", columns: ["id"] } },
  };
  const equivalent: DatabaseTable = {
    ...before,
    columns: [{ ...column("id"), dataType: { parameters: [10, 2], name: "decimal" } }],
    constraints: [
      { properties: { "vendor:deferrable": true, columns: ["id"], name: "key" }, kind: "Unique" },
    ],
  };
  assert.deepEqual(diff(database(before), database(equivalent)), { changes: [] });
  const changed = {
    ...before,
    options: { "vendor:partition": { method: "range", columns: ["id"] } },
  };
  const result = diff(database(before), database(changed)).changes[0]!;
  assert.equal(result._tag, "TableChanged");
  if (result._tag === "TableChanged") assert.equal(result.changes[0]!._tag, "TableOptionsChanged");
});

test("core detects column fields, ordering and ordered constraints", () => {
  const before = {
    ...table("t", [column("a"), column("b")]),
    constraints: [
      { kind: "Check", properties: { expression: "one" } },
      { kind: "Check", properties: { expression: "two" } },
    ],
  };
  const after = {
    ...table("t", [column("b", "text"), column("a")]),
    constraints: [...before.constraints].reverse(),
  };
  const result = diff(database(before), database(after)).changes[0]!;
  assert.equal(result._tag, "TableChanged");
  if (result._tag === "TableChanged")
    assert.deepEqual(
      result.changes.map((item) => item._tag),
      ["ColumnChanged", "ColumnOrderChanged", "TableConstraintsChanged"],
    );
});

test("core validates duplicate identities on both sides without assuming vendor name rules", () => {
  const duplicate = table("t", [column("id"), column("id")]);
  const result = Effect.runSync(
    Effect.result(diffDatabases(database(duplicate), database(table("t"), table("t")))),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof SchemaDiffError);
  assert.deepEqual(
    result.failure.diagnostics.map((item) => [item.side, item.code]),
    [
      ["before", "DuplicateColumn"],
      ["after", "DuplicateTable"],
    ],
  );
});

test("logical procedures describe intent without imposing dialect execution strategy", () => {
  const result = planDatabaseMigration(diff(database(table("old")), database(table("new"))));
  assert.deepEqual(
    result.procedures.map((item) => item._tag),
    ["DropTable", "CreateTable"],
  );
  assert.deepEqual(planDatabaseMigration(diff(database(), database())), { procedures: [] });
  assert.equal(JSON.stringify(result).includes("RebuildTable"), false);
});
