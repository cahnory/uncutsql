import { constants, type DatabaseSync } from "node:sqlite";

import { skipSqliteTrivia } from "@uncutsql/sqlite/tokens";

/** Execute the body of one transaction script inside a driver-owned transaction. */
export const executeScriptBody = (
  database: DatabaseSync,
  sql: string,
  historyName: string,
): void => {
  let phase: "before" | "body" | "after" = "before";
  let control: string | undefined;
  let foreignKeySetting = false;
  let denial: string | undefined;
  const deny = (reason: string) => {
    denial = reason;
    return constants.SQLITE_DENY;
  };
  database.setAuthorizer((action, first, second, namespace) => {
    if (action === constants.SQLITE_TRANSACTION) {
      if ((phase === "before" && first === "BEGIN") || (phase === "body" && first === "COMMIT")) {
        control = first;
        return constants.SQLITE_OK;
      }
      return deny("Migration scripts must contain exactly one BEGIN/COMMIT transaction");
    }
    if (action === constants.SQLITE_PRAGMA) {
      const name = first?.toLowerCase();
      const value = second?.toUpperCase();
      if (
        name === "foreign_keys" &&
        ((phase === "before" && (value === "OFF" || value === "0")) ||
          (phase === "after" && (value === "ON" || value === "1")))
      ) {
        foreignKeySetting = true;
        return constants.SQLITE_OK;
      }
      if (phase === "body" && name === "foreign_key_check") return constants.SQLITE_OK;
      return deny("Unsupported PRAGMA in migration script");
    }
    if (phase !== "body")
      return deny("Only foreign-key settings may appear outside the script transaction");
    if (
      action === constants.SQLITE_ATTACH ||
      action === constants.SQLITE_DETACH ||
      action === constants.SQLITE_SAVEPOINT
    )
      return deny("Attached databases and savepoints are not supported by this executor");
    if (namespace !== null && namespace !== "main" && namespace !== "temp")
      return deny("Only the main database may be migrated");
    if (
      first?.toLowerCase() === historyName ||
      (action === constants.SQLITE_ALTER_TABLE && second?.toLowerCase() === historyName)
    )
      return deny("Migration SQL cannot access the applied-history table");
    return constants.SQLITE_OK;
  });
  try {
    let offset = 0;
    while ((offset = skipSqliteTrivia(sql, offset)) < sql.length) {
      if (sql[offset] === ";") {
        offset++;
        continue;
      }
      control = undefined;
      foreignKeySetting = false;
      denial = undefined;
      let statement;
      try {
        statement = database.prepare(sql.slice(offset));
      } catch (cause) {
        throw new Error(denial ?? (cause instanceof Error ? cause.message : String(cause)));
      }
      const source = statement.sourceSQL;
      if (!source.length || !sql.startsWith(source, offset))
        throw new Error("SQLite did not consume the next SQL statement");
      offset += source.length;
      const transaction = control as string | undefined;
      if (transaction === "BEGIN") {
        if (statement.columns().length)
          throw new Error("EXPLAIN transaction statements are not supported");
        phase = "body";
      } else if (transaction === "COMMIT") {
        if (statement.columns().length)
          throw new Error("EXPLAIN transaction statements are not supported");
        phase = "after";
      } else if (!foreignKeySetting) {
        if (phase !== "body")
          throw new Error("Unsupported statement outside the script transaction");
        try {
          statement.run();
        } catch (cause) {
          throw new Error(denial ?? (cause instanceof Error ? cause.message : String(cause)));
        }
      }
    }
    if (phase !== "after") throw new Error("Migration script is missing its BEGIN/COMMIT envelope");
  } finally {
    database.setAuthorizer(null);
  }
};
