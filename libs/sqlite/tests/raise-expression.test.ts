import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { EncodeError, ParseError } from "@uncutsql/codec";

import { createTable, sqlExpression } from "../src/index.ts";
import type { RaiseExpression } from "../src/index.ts";
const encode = (sql: string) =>
  Effect.runSync(sqlExpression.encode(Effect.runSync(sqlExpression.decode(sql))));
for (const group of ["valid", "invalid", "edge"]) {
  const dir = new URL(`./fixtures/previous/raise-function/${group}/`, import.meta.url);
  for (const file of readdirSync(dir)) {
    test(`previous RAISE ${group}: ${file}`, () => {
      const source = readFileSync(new URL(file, dir), "utf8");
      const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
      if (group === "invalid") {
        assert.ok(Result.isFailure(result));
        assert.ok(result.failure instanceof ParseError);
      } else {
        assert.ok(Result.isSuccess(result));
        assert.deepEqual(Effect.runSync(sqlExpression.decode(encode(source))), result.success);
      }
    });
  }
}

test("RAISE retains SQLite trigger actions and expression messages", () => {
  for (const action of ["IGNORE", "ABORT", "FAIL", "ROLLBACK"]) {
    const source =
      action === "IGNORE" ? "RAISE(IGNORE)" : `RAISE(${action}, 'bad:' || CAST(NEW.value AS TEXT))`;
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE t(value); CREATE TRIGGER reject_value BEFORE INSERT ON t WHEN NEW.value < 0 BEGIN SELECT ${encode(source)}; END;`,
      );
      db.exec("BEGIN; INSERT INTO t VALUES (1)");
      if (action === "IGNORE") {
        db.exec("INSERT INTO t VALUES(-2)");
        assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()!.n, 1);
      } else {
        assert.throws(() => db.exec("INSERT INTO t VALUES(-2)"), /bad:-2/);
        assert.equal(db.isTransaction, action !== "ROLLBACK");
      }
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()!.n, 0);
    } finally {
      db.close();
    }
  }
});

test("RAISE validates action/message combinations and stays unavailable in defaults", () => {
  for (const source of [
    "RAISE()",
    "RAISE(UNKNOWN)",
    "RAISE(IGNORE,1)",
    "RAISE(FAIL)",
    "RAISE(ABORT,)",
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.decode(source)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof ParseError);
  }
  // Test defensive encoding at an untyped input boundary.
  for (const value of [
    { _tag: "RaiseExpression", action: "IGNORE", message: { _tag: "NullLiteral" } },
    { _tag: "RaiseExpression", action: "FAIL" },
  ]) {
    const result = Effect.runSync(Effect.result(sqlExpression.encode(value as RaiseExpression)));
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof EncodeError);
  }
  assert.ok(
    Result.isFailure(
      Effect.runSync(
        Effect.result(createTable.decode("CREATE TABLE t(a DEFAULT (RAISE(IGNORE)))")),
      ),
    ),
  );
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => db.prepare(`SELECT ${encode("RAISE(IGNORE)")}`), /trigger/);
  } finally {
    db.close();
  }
});
