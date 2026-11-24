import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect } from "effect";
import { createView, schema, toDatabaseSchema } from "../src/index.ts";

test("view round trips retain native column names and results", () => {
  for (const sql of [
    "CREATE TEMP VIEW IF NOT EXISTS temp.v(x, y) AS VALUES (1, 2)",
    "CREATE VIEW main.v AS WITH data(n) AS (VALUES (2)) SELECT n COLLATE binary, n+1 FROM data",
  ]) {
    const ast = Effect.runSync(createView.decode(sql));
    const formatted = Effect.runSync(createView.encode(ast));
    assert.deepEqual(Effect.runSync(schema.decode(formatted)), [ast]);
    const inspect = (source: string) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(source);
        return db.prepare("SELECT * FROM v").all();
      } finally {
        db.close();
      }
    };
    assert.deepEqual(inspect(formatted), inspect(sql));
    assert.throws(() => Effect.runSync(toDatabaseSchema([ast])), /CREATE VIEW/);
  }
});

test("view declarations reject missing queries and empty result column lists", () => {
  for (const sql of [
    "CREATE VIEW v AS",
    "CREATE VIEW v() AS SELECT 1",
    "CREATE UNIQUE VIEW v AS SELECT 1",
  ])
    assert.throws(() => Effect.runSync(schema.decode(sql)));
});
