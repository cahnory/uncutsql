import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import {
  prepareMigrationDecisions,
  mergeMigrationDecisions,
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
  assert.deepEqual(pending.decisions[0]!.resolution, { action: "pending" });
  for (const resolution of [{ action: "drop" }, { action: "rename", target: "new" }]) {
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
      resolution.action === "drop" ? ["ColumnRemoved", "ColumnAdded"] : ["ColumnRenamed"],
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
    { ...pending, decisions: [{ ...first, resolution: { action: "rename", target: "missing" } }] },
    {
      ...pending,
      decisions: [
        { ...first, resolution: { action: "drop" } },
        { ...first, resolution: { action: "drop" } },
      ],
    },
    { ...pending, decisions: [{ ...first, id: "unknown", resolution: { action: "drop" } }] },
    { ...pending, decisions: [{ ...first, column: "other", resolution: { action: "drop" } }] },
  ])
    failure(document);
  for (const resolution of [
    null,
    {},
    { action: "pending" },
    { action: "rename" },
    { action: "drop", target: "new" },
    { action: "rename", target: "new", extra: true },
    { action: "other" },
    { _tag: "Drop" },
  ]) {
    failure({ ...pending, decisions: [{ ...first, resolution }] });
  }
  assert.match(failure(pending).message, /Unresolved decision/);
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
              resolution: { action: "rename", target: "x" },
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
        decisions: doc.decisions.map((item) => ({ ...item, resolution: { action: "drop" } })),
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
          item.column === "old_a" ? { action: "rename", target: "new_a" } : { action: "drop" },
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

test("changing a table pairing discards only its dependent column answers", () => {
  const table = (name: string, column: string) => ({
    ...model([column]).tables[0]!,
    name,
    identity: { name },
  });
  const source = { tables: [table("old", "value"), table("other", "value")] };
  const target = { tables: [table("first", "label"), table("second", "label")] };
  const fresh = Effect.runSync(prepareMigrationDecisions(source, target));
  const pair = (target: string) => ({ action: "rename" as const, target });
  const answered = {
    ...fresh,
    decisions: fresh.decisions.map((item) => ({
      ...item,
      resolution: item.table.name === "old" ? pair("first") : { action: "drop" as const },
    })),
  };
  const merge = (document: unknown) => Effect.runSync(mergeMigrationDecisions(fresh, document));
  const expanded = merge(answered);
  assert.equal(expanded.decisions.length, 3);
  const complete = merge({
    ...expanded,
    decisions: expanded.decisions.map((item) =>
      item.column ? { ...item, resolution: pair("label") } : item,
    ),
  });
  assert.deepEqual(merge(complete), complete);
  const changed = merge({
    ...complete,
    decisions: complete.decisions.map((item) =>
      item.table.name === "old" && !item.column ? { ...item, resolution: pair("second") } : item,
    ),
  });
  assert.equal(changed.decisions[2]!.resolution.action, "pending");
  assert.notEqual(changed.decisions[2]!.id, complete.decisions[2]!.id);
  assert.throws(
    () =>
      merge({
        ...answered,
        decisions: answered.decisions.map((item) => ({
          ...item,
          resolution: pair("first"),
        })),
      }),
    /Multiple source tables/,
  );
});
