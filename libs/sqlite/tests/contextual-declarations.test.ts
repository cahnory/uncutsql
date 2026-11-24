import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { createTable, schema } from "../src/index.ts";
import { keywords } from "../src/lexer/keywords.ts";

test("column declarations, foreign keys and index targets accept SQLite's bare names", () => {
  for (const keyword of keywords) {
    const name = keyword[0] + keyword.slice(1).toLowerCase();
    using db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE "${name}" (id)`);
    for (const source of [
      `CREATE TABLE t (${name} INTEGER PRIMARY KEY)`,
      `CREATE TABLE t (x, ${name}, UNIQUE(x))`,
      `CREATE VIEW v (x, ${name}) AS SELECT 1, 2`,
      `CREATE TABLE t (x REFERENCES ${name}(id) ON UPDATE CASCADE)`,
      `CREATE TABLE t (x, y, FOREIGN KEY(x, y) REFERENCES p(id, ${name}))`,
      `CREATE TABLE t (x, "${name}", FOREIGN KEY(x, ${name}) REFERENCES p(a, b))`,
      `CREATE INDEX i ON ${name}(id)`,
    ]) {
      const parsed = Effect.runSync(Effect.result(schema.decode(source)));
      try {
        db.prepare(source);
      } catch {
        assert.ok(Result.isFailure(parsed), source);
        continue;
      }
      assert.ok(Result.isSuccess(parsed), source);
      const rendered = Effect.runSync(schema.encode(parsed.success));
      assert.deepEqual(Effect.runSync(schema.decode(rendered)), parsed.success, source);
      const metadata = (sql: string) => {
        db.exec("SAVEPOINT ddl");
        try {
          db.exec(sql);
          return [
            "table_info(t)",
            "table_info(v)",
            "foreign_key_list(t)",
            "index_list(t)",
            "index_info(i)",
          ].map((pragma) => db.prepare(`PRAGMA ${pragma}`).all());
        } finally {
          db.exec("ROLLBACK TO ddl; RELEASE ddl");
        }
      };
      assert.deepEqual(metadata(rendered), metadata(source), source);
    }
  }
});

test("column and table CHECK constraint names match SQLite and retain their spelling", () => {
  using db = new DatabaseSync(":memory:");
  const names = [...keywords].map((word) => {
    const name = word[0] + word.slice(1).toLowerCase();
    return [name, name] as const;
  });
  for (const [token, name] of [...names, ["'owner''s check'", "owner's check"]]) {
    for (const separator of [" ", ", "]) {
      const source = `CREATE TABLE t (x${separator}CONSTRAINT ${token} CHECK (x > 0))`;
      const parsed = Effect.runSync(Effect.result(createTable.decode(source)));
      try {
        db.prepare(source);
      } catch {
        assert.ok(Result.isFailure(parsed), source);
        continue;
      }
      assert.ok(Result.isSuccess(parsed), source);
      const constraints =
        separator === " "
          ? parsed.success.columns[0]!.constraints
          : parsed.success.tableConstraints;
      assert.deepEqual(
        constraints.map((constraint) => constraint.name),
        [name],
        source,
      );
      const rendered = Effect.runSync(createTable.encode(parsed.success));
      db.prepare(rendered);
      assert.deepEqual(Effect.runSync(createTable.decode(rendered)), parsed.success, source);
    }
  }
});

test("foreign key MATCH names agree with SQLite and survive formatting", () => {
  using db = new DatabaseSync(":memory:");
  const names = [...keywords].map((word) => word[0] + word.slice(1).toLowerCase());
  for (const token of [...names, "'owner''s mode'"]) {
    const name = token === "'owner''s mode'" ? "owner's mode" : token;
    const source = `CREATE TABLE t (x REFERENCES p MATCH ${token} ON DELETE CASCADE)`;
    const parsed = Effect.runSync(Effect.result(createTable.decode(source)));
    try {
      db.prepare(source);
    } catch {
      assert.ok(Result.isFailure(parsed), source);
      continue;
    }
    assert.ok(Result.isSuccess(parsed), source);
    const constraint = parsed.success.columns[0]!.constraints[0]!;
    assert.equal(constraint._tag, "References");
    assert.deepEqual(
      constraint.references.options,
      [
        { _tag: "Match", name },
        { _tag: "OnDelete", action: "CASCADE" },
      ],
      source,
    );
    const rendered = Effect.runSync(createTable.encode(parsed.success));
    db.prepare(rendered);
    assert.deepEqual(Effect.runSync(createTable.decode(rendered)), parsed.success, source);
  }
});
