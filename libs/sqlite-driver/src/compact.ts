import { DatabaseSync } from "node:sqlite";

import type { MigrationSource } from "@uncutsql/core";

import { executeScriptBody } from "./script.ts";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const dumpRows = (db: DatabaseSync, table: string, lines: string[]) => {
  const columns = db.prepare("SELECT name, hidden FROM pragma_table_xinfo(?)").all(table);
  const names = columns.filter((c) => c.hidden === 0).map((c) => String(c.name));
  const quoted = identifier(table);
  const rowidTable =
    db.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?").get(table)?.wr ===
    0;
  if (rowidTable && table !== "sqlite_sequence") {
    const rowid = ["rowid", "_rowid_", "oid"].find(
      (name) => !columns.some((c) => String(c.name).toLowerCase() === name),
    );
    if (rowid) {
      names.unshift(rowid);
    }
  }
  const fields = names.map(identifier);
  // SQLite performs the conversion so 64-bit integers never pass through a JS number.
  const literals = fields.map(
    (field) => `CASE typeof(${field})
    WHEN 'text' THEN 'CAST(X''' || hex(${field}) || ''' AS TEXT)'
    WHEN 'real' THEN CASE WHEN abs(${field}) > 1.7976931348623157e308
      THEN iif(${field} < 0, '-1e999', '1e999') ELSE printf('%!.26g', ${field}) END
    ELSE quote(${field}) END`,
  );
  const rows = db.prepare(`SELECT ${literals.join(",")} FROM ${quoted} NOT INDEXED`);
  rows.setReturnArrays(true);
  for (const row of rows.iterate()) {
    lines.push(
      `INSERT INTO ${quoted} (${fields.join(", ")}) VALUES (${Object.values(row).join(",")});`,
    );
  }
};

const dump = (db: DatabaseSync) => {
  const lines = [
    "-- uncutsql-down unavailable: Compacted baseline.",
    "PRAGMA foreign_keys=OFF;",
    "BEGIN;",
  ];
  const objects = db
    .prepare("SELECT type, name, sql FROM main.sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid")
    .all();
  const tables = objects.filter(
    (obj) => obj.type === "table" && !String(obj.name).startsWith("sqlite_"),
  );
  const hasSequence = objects.some((obj) => obj.name === "sqlite_sequence");
  if (hasSequence) {
    // sqlite_sequence survives even when the last AUTOINCREMENT table is dropped.
    // Initialize it on the empty target before any user object names exist.
    lines.push(
      "CREATE TABLE __sequence_init (id INTEGER PRIMARY KEY AUTOINCREMENT);",
      "DROP TABLE __sequence_init;",
    );
  }
  for (const table of tables) {
    lines.push(`${table.sql};`);
  }
  for (const table of tables) {
    dumpRows(db, String(table.name), lines);
  }
  if (hasSequence) {
    lines.push("DELETE FROM sqlite_sequence;");
    dumpRows(db, "sqlite_sequence", lines);
  }
  for (const obj of objects) {
    if (obj.type !== "table" && !String(obj.name).startsWith("sqlite_")) {
      lines.push(`${obj.sql};`);
    }
  }
  return [...lines, "COMMIT;", "PRAGMA foreign_keys=ON;", ""].join("\n");
};

export const compactSqlite = (migrations: readonly MigrationSource[], historyName: string) => {
  const db = new DatabaseSync(":memory:");
  const restored = new DatabaseSync(":memory:");
  try {
    const replay = (target: DatabaseSync, sql: string) => {
      target.exec("PRAGMA foreign_keys=OFF; BEGIN;");
      executeScriptBody(target, sql, historyName);
      if (target.prepare("PRAGMA foreign_key_check").get()) {
        throw new Error("Foreign key violation during compaction");
      }
      target.exec("COMMIT");
    };
    for (const migration of migrations) {
      replay(db, migration.sql);
    }
    const sql = dump(db);
    replay(restored, sql);
    if (dump(restored) !== sql) {
      throw new Error("Restored baseline differs from the replayed prefix");
    }
    return sql;
  } finally {
    restored.close();
    db.close();
  }
};
