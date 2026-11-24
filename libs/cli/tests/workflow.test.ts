import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { prepareMigrationDecisions } from "@uncutsql/core";
import type { DatabaseMigration, DatabaseSchema, Dialect } from "@uncutsql/core";

import { compareSchemas, renderMigration } from "../src/workflow.ts";

// A second adapter with a different AST/plan and case-sensitive names. It has no diff function.
const adapter: Dialect<{ model: DatabaseSchema }, { logical: DatabaseMigration }, never> = {
  encodeMigration: (plan) =>
    Effect.succeed(plan.logical.procedures.map((item) => item._tag).join(",")),
  format: (ast) => Effect.succeed(JSON.stringify(ast.model)),
  lowerMigration: (logical) => Effect.succeed({ logical }),
  name: "fixture",
  parse: (source) => Effect.sync(() => ({ model: JSON.parse(source) as DatabaseSchema })),
  toDatabaseSchema: (ast) => Effect.succeed(ast.model),
};
const model = (name: string): DatabaseSchema => ({
  tables: [
    {
      columns: [],
      constraints: [],
      identity: { catalog: "app", name, schema: "public" },
      name,
      options: {},
    },
  ],
});

test("consumer workflow swaps dialect adapters without changing its diff or planning logic", () => {
  const comparison = Effect.runSync(
    compareSchemas(adapter, { model: model("Foo") }, { model: model("foo") }),
  );
  assert.deepEqual(
    comparison.diff.changes.map((item) => item._tag),
    ["TableRemoved", "TableAdded"],
  );
  const pending = Effect.runSync(prepareMigrationDecisions(comparison.before, comparison.after));
  const choices = {
    ...pending,
    decisions: pending.decisions.map((item) => ({ ...item, resolution: { action: "drop" } })),
  };
  assert.throws(
    () =>
      Effect.runSync(
        renderMigration(adapter, comparison, {
          ...pending,
          decisions: pending.decisions.map((item) => ({
            ...item,
            resolution: { action: "drop_if_empty" },
          })),
        }),
      ),
    /does not support drop_if_empty/,
  );
  assert.match(
    Effect.runSync(renderMigration(adapter, comparison, choices)),
    /DropTable,CreateTable$/,
  );
});

test("consumer workflow preserves no-op logical migrations for a non-SQLite adapter", () => {
  const input = { model: model("t") };
  const comparison = Effect.runSync(compareSchemas(adapter, input, input));
  assert.deepEqual(comparison.diff, { changes: [] });
  assert.equal(Effect.runSync(renderMigration(adapter, comparison)), "");
});
