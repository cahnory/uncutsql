import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import {
  prepareMigrationDecisions,
  resolveMigrationDecisions,
  MigrationDecisionError,
  type DatabaseSchema,
} from "../src/index.ts";
const model = (names: string[], type = "TEXT"): DatabaseSchema => ({
  tables: [
    {
      identity: { catalog: "main", name: "t" },
      name: "t",
      columns: names.map((name) => ({ key: name, name, dataType: type, constraints: [] })),
      constraints: [],
      options: {},
    },
  ],
});
const before = model(["old"]),
  after = model(["new"], "INTEGER");
const prepare = () => Effect.runSync(prepareMigrationDecisions(before, after));
const failure = (input?: unknown) => {
  const result = Effect.runSync(Effect.result(resolveMigrationDecisions(before, after, input)));
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof MigrationDecisionError);
  return result.failure;
};
test("ambiguities remain unresolved until explicit drop or rename choices", () => {
  assert.equal(failure().pending.decisions.length, 1);
  const pending = prepare();
  assert.deepEqual(pending.decisions[0]!.candidates, ["new"]);
  assert.equal(pending.decisions[0]!.resolution, null);
  for (const resolution of [{ _tag: "Drop" }, { _tag: "Rename", target: "new" }]) {
    const resolved = Effect.runSync(
      resolveMigrationDecisions(before, after, {
        ...pending,
        decisions: pending.decisions.map((item) => ({ ...item, resolution })),
      }),
    );
    const change = resolved.diff.changes[0]!;
    assert.equal(change._tag, "TableChanged");
    if (change._tag !== "TableChanged") throw new Error("Expected table change");
    assert.deepEqual(
      change.changes.map((item) => item._tag),
      resolution._tag === "Drop" ? ["ColumnRemoved", "ColumnAdded"] : ["ColumnRenamed"],
    );
    if (change.changes[0]!._tag === "ColumnRenamed")
      assert.deepEqual(change.changes[0]!.fields, ["dataType"]);
  }
});
test("decisions reject stale, missing, duplicated and invalid resolutions", () => {
  const pending = prepare(),
    first = pending.decisions[0]!;
  for (const document of [
    null,
    {},
    { ...pending, before: model(["different"]) },
    { ...pending, decisions: [] },
    pending,
    { ...pending, decisions: [{ ...first, resolution: { _tag: "Rename", target: "missing" } }] },
    {
      ...pending,
      decisions: [
        { ...first, resolution: { _tag: "Drop" } },
        { ...first, resolution: { _tag: "Drop" } },
      ],
    },
    { ...pending, decisions: [{ ...first, id: "unknown", resolution: { _tag: "Drop" } }] },
    { ...pending, decisions: [{ ...first, column: "other", resolution: { _tag: "Drop" } }] },
  ])
    failure(document);
  const a = model(["a", "b"]),
    b = model(["x"]);
  const doc = Effect.runSync(prepareMigrationDecisions(a, b));
  assert.ok(
    Result.isFailure(
      Effect.runSync(
        Effect.result(
          resolveMigrationDecisions(a, b, {
            ...doc,
            decisions: doc.decisions.map((item) => ({
              ...item,
              resolution: { _tag: "Rename", target: "x" },
            })),
          }),
        ),
      ),
    ),
  );
});
test("table drops require consent but additions need no decisions", () => {
  const empty = { tables: [] };
  assert.equal(
    Effect.runSync(resolveMigrationDecisions(empty, before)).decisions.decisions.length,
    0,
  );
  const doc = Effect.runSync(prepareMigrationDecisions(before, empty));
  assert.equal(doc.decisions[0]!.column, undefined);
  assert.ok(
    Result.isFailure(Effect.runSync(Effect.result(resolveMigrationDecisions(before, empty)))),
  );
  assert.equal(
    Effect.runSync(
      resolveMigrationDecisions(before, empty, {
        ...doc,
        decisions: doc.decisions.map((item) => ({ ...item, resolution: { _tag: "Drop" } })),
      }),
    ).diff.changes[0]!._tag,
    "TableRemoved",
  );
});

test("mixed rename/drop decisions retain other additions and accompanying constraint changes", () => {
  const a = model(["old_a", "old_b"]);
  const b: DatabaseSchema = {
    ...model(["new_a", "new_b"], "INTEGER"),
    tables: model(["new_a", "new_b"], "INTEGER").tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({
        ...column,
        constraints: [{ kind: "NotNull", properties: {} }],
      })),
    })),
  };
  const doc = Effect.runSync(prepareMigrationDecisions(a, b));
  const resolved = Effect.runSync(
    resolveMigrationDecisions(a, b, {
      ...doc,
      decisions: doc.decisions.map((item) => ({
        ...item,
        resolution:
          item.column === "old_a" ? { _tag: "Rename", target: "new_a" } : { _tag: "Drop" },
      })),
    }),
  );
  const change = resolved.diff.changes[0]!;
  if (change._tag !== "TableChanged") throw new Error("Expected altered table");
  assert.deepEqual(
    change.changes.map((item) => item._tag),
    ["ColumnRenamed", "ColumnRemoved", "ColumnAdded"],
  );
  const rename = change.changes[0]!;
  if (rename._tag !== "ColumnRenamed") throw new Error("Expected rename");
  assert.deepEqual(rename.fields, ["dataType", "constraints"]);
});
