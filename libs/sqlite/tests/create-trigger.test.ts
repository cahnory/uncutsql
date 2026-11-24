import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect } from "effect";
import type { SourceNode } from "@uncutsql/codec";
import { createTrigger, fromDatabaseSchema, schema, toDatabaseSchema } from "../src/index.ts";

test("multi-action triggers round trip and execute in source order", () => {
  const source = `CREATE TRIGGER audit AFTER UPDATE OF n ON items FOR EACH ROW WHEN NEW.n > OLD.n BEGIN
    INSERT OR IGNORE INTO logs(n) VALUES (OLD.n), (NEW.n);
    UPDATE logs SET n = n + 1 WHERE n = OLD.n;
    DELETE FROM logs WHERE n = NEW.n;
    SELECT CASE WHEN NEW.n > 10 THEN RAISE(ABORT, 'too high;') END;
  END;`;
  const trigger = Effect.runSync(createTrigger.decode(source));
  const formatted = Effect.runSync(createTrigger.encode(trigger));
  assert.deepEqual(Effect.runSync(schema.decode(formatted)), [trigger]);
  for (const sql of [source, formatted]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE items(n); CREATE TABLE logs(n); INSERT INTO items VALUES (2)");
      db.exec(sql);
      db.exec("UPDATE items SET n = 5");
      assert.deepEqual(
        db
          .prepare("SELECT n FROM logs")
          .all()
          .map((row) => row.n),
        [3],
      );
      assert.throws(() => db.exec("UPDATE items SET n = 15"), /too high;/);
    } finally {
      db.close();
    }
  }
});
test("trigger and target identifiers have exact source ranges in a schema document", () => {
  const sql =
    'CREATE TEMP TRIGGER IF NOT EXISTS temp."tr one" INSTEAD OF DELETE ON main.[my view] BEGIN SELECT 1; END; CREATE TABLE t(n)';
  const { value, sourceMap } = Effect.runSync(schema.decodeWithSourceMap(sql));
  assert.deepEqual(
    value.map((item) => item._tag),
    ["CreateTrigger", "CreateTable"],
  );
  function identifiers(nodes: readonly SourceNode[]): string[] {
    return nodes.flatMap((node) =>
      node.kind === "Identifier" ? [sql.slice(node.start, node.end)] : identifiers(node.children),
    );
  }
  assert.deepEqual(identifiers(sourceMap[0]!.children), ["temp", '"tr one"', "main", "[my view]"]);
  assert.throws(() => Effect.runSync(toDatabaseSchema(value)), /Invalid SQLite trigger/);
});
test("trigger action lists require an action and every internal semicolon", () => {
  for (const body of [
    "END",
    "SELECT 1 END",
    "SELECT 1; SELECT 2 END",
    "UPDATE main.t SET n=1; END",
  ])
    assert.throws(() =>
      Effect.runSync(schema.decode("CREATE TRIGGER tr BEFORE INSERT ON t BEGIN " + body)),
    );
});

test("table and view triggers survive JSON restoration with resolved owners and ordered actions", () => {
  const ast = Effect.runSync(
    schema.decode(`
    CREATE TABLE Items(n); CREATE VIEW v AS SELECT n FROM Items;
    CREATE TRIGGER items INSERT ON Items BEGIN SELECT NEW.n; SELECT 2; END;
    CREATE TEMP TRIGGER tr INSTEAD OF DELETE ON main.v BEGIN DELETE FROM Items WHERE n = OLD.n; END;
  `),
  );
  const model = Effect.runSync(toDatabaseSchema(ast));
  assert.deepEqual(
    model.triggers?.map((t) => [t.identity.catalog, t.target]),
    [
      ["main", { catalog: "main", name: "items" }],
      ["temp", { catalog: "main", name: "v" }],
    ],
  );
  const restored = Effect.runSync(fromDatabaseSchema(JSON.parse(JSON.stringify(model))));
  assert.deepEqual(Effect.runSync(toDatabaseSchema(restored)), model);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(Effect.runSync(schema.encode(restored)));
    db.exec("INSERT INTO Items VALUES (2); DELETE FROM v");
    assert.equal(db.prepare("SELECT n FROM Items").get(), undefined);
  } finally {
    db.close();
  }
});
