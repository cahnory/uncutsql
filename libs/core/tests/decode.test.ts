import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { decodeDatabaseSchema, SchemaModelError } from "../src/index.ts";

const valid = () => ({
  tables: [
    {
      columns: [
        { constraints: [], dataType: { args: [10, 2], name: "decimal" }, key: "id", name: "id" },
      ],
      constraints: [{ kind: "PrimaryKey", properties: { columns: ["id"] } }],
      identity: { catalog: "app", name: "t", schema: "public" },
      name: "t",
      options: { "vendor:feature": true },
    },
  ],
});

test("external shared models decode without discarding semantic values", () => {
  const model = valid();
  assert.equal(Effect.runSync(decodeDatabaseSchema(model)), model);
  assert.deepEqual(Effect.runSync(decodeDatabaseSchema(JSON.parse(JSON.stringify(model)))), model);
});

test("malformed model shapes and unknown fields produce path-based typed errors", () => {
  for (const [value, path] of [
    [null, "$database"],
    [{ tables: "bad" }, "$database.tables"],
    [{ future: true, tables: [] }, "$database.future"],
    [
      { tables: [{ ...valid().tables[0]!, columns: [{ dataType: null, key: "id", name: "id" }] }] },
      "$database.tables[0].columns[0].constraints",
    ],
    [
      { tables: [{ ...valid().tables[0]!, identity: { catalog: 1, name: "t" } }] },
      "$database.tables[0].identity.catalog",
    ],
  ] as const) {
    const result = Effect.runSync(Effect.result(decodeDatabaseSchema(value)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof SchemaModelError);
    assert.equal(result.failure.path, path);
  }
});

test("non-JSON values and cycles cannot enter a serialized baseline", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const dataType of [NaN, Infinity, undefined, new Date(), cycle]) {
    const model = {
      tables: [
        { ...valid().tables[0]!, columns: [{ ...valid().tables[0]!.columns[0]!, dataType }] },
      ],
    };
    assert.ok(Result.isFailure(Effect.runSync(Effect.result(decodeDatabaseSchema(model)))));
  }
});
