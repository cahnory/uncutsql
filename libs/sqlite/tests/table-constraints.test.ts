import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { EncodeError, ParseError } from "@uncutsql/codec";
import { createTable, type CreateTable } from "../src/index.ts";

const decode = (source: string) => Effect.runSync(createTable.decode(source));
const encode = (value: CreateTable) => Effect.runSync(createTable.encode(value));
const versions = (source: string): readonly string[] => {
  const ast = decode(source);
  const canonical = encode(ast);
  assert.deepEqual(decode(canonical), ast);
  return [source, canonical];
};
const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};

test("column and table constraint names and ordering are retained", () => {
  const source = `CREATE TABLE t (
    a INTEGER CONSTRAINT positive CHECK (a > 0) CONSTRAINT required NOT NULL,
    b TEXT CONSTRAINT distinct_b UNIQUE,
    CONSTRAINT pair_key PRIMARY KEY (a, b),
    CONSTRAINT pair_unique UNIQUE (a, b),
    CONSTRAINT present CHECK (a NOT NULL)
  )`;
  const ast = decode(source);
  assert.deepEqual(
    ast.columns[0]!.constraints.map((value) => value.name),
    ["positive", "required"],
  );
  assert.deepEqual(
    ast.tableConstraints.map((value) => [value._tag, value.name]),
    [
      ["PrimaryKey", "pair_key"],
      ["Unique", "pair_unique"],
      ["Check", "present"],
    ],
  );
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec("INSERT INTO t VALUES (1, 'one')");
      assert.throws(
        () => database.exec("INSERT INTO t VALUES (0, 'zero')"),
        /CHECK constraint failed/,
      );
      assert.throws(
        () => database.exec("INSERT INTO t VALUES (2, 'one')"),
        /UNIQUE constraint failed/,
      );
    } finally {
      database.close();
    }
  }
});

test("table keys retain collation, sort order and conflict action", () => {
  const source =
    "CREATE TABLE t (a TEXT, b INTEGER, PRIMARY KEY (a DESC, b ASC) ON CONFLICT ABORT, UNIQUE (a COLLATE NOCASE DESC) ON CONFLICT IGNORE)";
  const ast = decode(source);
  assert.equal(ast.tableConstraints[0]!._tag, "PrimaryKey");
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      database.exec("INSERT INTO t VALUES ('A', 1)");
      database.exec("INSERT INTO t VALUES ('a', 2)");
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM t").get()!.n, 1);
      const unique = database
        .prepare("PRAGMA index_list(t)")
        .all()
        .find((row) => row.origin === "u")!;
      const index = database.prepare(`PRAGMA index_xinfo('${unique.name}')`).all();
      assert.equal(index[0]!.coll, "NOCASE");
      assert.equal(index[0]!.desc, 1);
    } finally {
      database.close();
    }
  }
});

test("composite foreign keys preserve ON clause order and cascade updates/deletes", () => {
  const source = `CREATE TABLE child (
    x INTEGER, y INTEGER,
    CONSTRAINT fk_pair FOREIGN KEY (x, y) REFERENCES parent(a, b)
      ON UPDATE CASCADE ON DELETE CASCADE MATCH SIMPLE
  )`;
  const ast = decode(source);
  const constraint = ast.tableConstraints[0]!;
  assert.equal(constraint._tag, "ForeignKey");
  if (constraint._tag !== "ForeignKey") assert.fail("Expected foreign key");
  assert.deepEqual(
    constraint.references.options.map((value) => value._tag),
    ["OnUpdate", "OnDelete", "Match"],
  );
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "PRAGMA foreign_keys = ON; CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
      );
      database.exec(sql);
      database.exec("INSERT INTO parent VALUES (1,2); INSERT INTO child VALUES (1,2)");
      database.exec("UPDATE parent SET a = 3 WHERE a = 1");
      assert.deepEqual({ ...database.prepare("SELECT * FROM child").get()! }, { x: 3, y: 2 });
      database.exec("DELETE FROM parent");
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM child").get()!.n, 0);
      assert.throws(
        () => database.exec("INSERT INTO child VALUES (8,9)"),
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      database.close();
    }
  }
});

test("named column references support omitted target columns and SET DEFAULT", () => {
  const source =
    "CREATE TABLE child (id INTEGER DEFAULT 0 CONSTRAINT parent_ref REFERENCES parent ON DELETE SET DEFAULT ON UPDATE RESTRICT)";
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "PRAGMA foreign_keys = ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (0),(1)",
      );
      database.exec(sql);
      database.exec("INSERT INTO child VALUES (1)");
      assert.throws(
        () => database.exec("UPDATE parent SET id=2 WHERE id=1"),
        /FOREIGN KEY constraint failed/,
      );
      database.exec("DELETE FROM parent WHERE id=1");
      assert.equal(database.prepare("SELECT id FROM child").get()!.id, 0);
    } finally {
      database.close();
    }
  }
});

test("deferred foreign keys allow child-before-parent insertion until commit", () => {
  const source =
    "CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)";
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON; CREATE TABLE parent(id INTEGER PRIMARY KEY)");
      database.exec(sql);
      database.exec("BEGIN; INSERT INTO child VALUES (1); INSERT INTO parent VALUES (1); COMMIT");
      database.exec("BEGIN; INSERT INTO child VALUES (2)");
      assert.throws(() => database.exec("COMMIT"), /FOREIGN KEY constraint failed/);
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
});

test("NOT DEFERRABLE remains immediate even with INITIALLY DEFERRED", () => {
  const source =
    "CREATE TABLE child (id INTEGER REFERENCES parent(id) NOT DEFERRABLE INITIALLY DEFERRED)";
  for (const sql of versions(source)) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON; CREATE TABLE parent(id INTEGER PRIMARY KEY)");
      database.exec(sql);
      database.exec("BEGIN");
      assert.throws(
        () => database.exec("INSERT INTO child VALUES (1)"),
        /FOREIGN KEY constraint failed/,
      );
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
});

test("remaining reference actions and deferral modes round-trip", () => {
  for (const ending of [
    "ON DELETE SET NULL",
    "ON UPDATE NO ACTION",
    "DEFERRABLE",
    "DEFERRABLE INITIALLY IMMEDIATE",
    "NOT DEFERRABLE",
    "MATCH 'bad'",
  ]) {
    if (ending === "MATCH 'bad'") {
      assert.ok(
        failure(
          createTable.decode(`CREATE TABLE child (id REFERENCES parent ${ending})`),
        ) instanceof ParseError,
      );
      continue;
    }
    for (const sql of versions(`CREATE TABLE child (id REFERENCES parent ${ending})`)) {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec("CREATE TABLE parent(id PRIMARY KEY)");
        database.exec(sql);
      } finally {
        database.close();
      }
    }
  }
});

for (const source of [
  "CREATE TABLE t (PRIMARY KEY (a))",
  "CREATE TABLE t (a, PRIMARY KEY ())",
  "CREATE TABLE t (a, UNIQUE ())",
  "CREATE TABLE t (a, PRIMARY KEY (a + 1))",
  "CREATE TABLE t (a, UNIQUE (a), b)",
  "CREATE TABLE t (a, UNIQUE (a),)",
  "CREATE TABLE t (a, UNIQUE (a) ON CONFLICT)",
  "CREATE TABLE t (a, CONSTRAINT c)",
  "CREATE TABLE t (a CONSTRAINT c)",
  "CREATE TABLE t (a CONSTRAINT CHECK (a))",
  "CREATE TABLE t (a REFERENCES)",
  "CREATE TABLE t (a REFERENCES parent())",
  "CREATE TABLE t (a REFERENCES parent(id,))",
  "CREATE TABLE t (a REFERENCES parent ON DELETE)",
  "CREATE TABLE t (a REFERENCES parent ON DELETE SET)",
  "CREATE TABLE t (a REFERENCES parent MATCH)",
  "CREATE TABLE t (a REFERENCES parent DEFERRABLE INITIALLY)",
  "CREATE TABLE t (a REFERENCES parent NOT)",
  "CREATE TABLE t (a, FOREIGN KEY () REFERENCES parent(id))",
  "CREATE TABLE t (a, FOREIGN KEY (a))",
]) {
  test(`rejects malformed table/foreign-key constraint: ${source}`, () => {
    assert.ok(failure(createTable.decode(source)) instanceof ParseError);
  });
}

test("generated constraints reject empty key/reference lists", () => {
  const base = decode("CREATE TABLE t (a INTEGER)");
  assert.ok(
    failure(
      createTable.encode({ ...base, tableConstraints: [{ _tag: "Unique", columns: [] }] }),
    ) instanceof EncodeError,
  );
  assert.ok(
    failure(
      createTable.encode({
        ...base,
        tableConstraints: [
          {
            _tag: "ForeignKey",
            columns: ["a"],
            references: { table: "parent", columns: [], options: [] },
          },
        ],
      }),
    ) instanceof EncodeError,
  );
});
