import { Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import { createTable, type CreateTable } from "./create-table.ts";
import { identifier } from "./codecs/identifier.ts";
import { stringLiteral } from "./codecs/string-literal.ts";
import type { TableIdentity } from "./diff.ts";
import { foldIdentifier } from "./schema-identity.ts";

export interface RebuildTableOperation {
  readonly _tag: "RebuildTable";
  readonly table: TableIdentity;
  readonly before: CreateTable;
  readonly after: CreateTable;
  readonly temporaryName: string;
}

export const qualifiedTable = (table: TableIdentity) =>
  Effect.gen(function* () {
    const schema = yield* identifier.encode(table.schema);
    const name = yield* identifier.encode(table.name);
    return `${schema}.${name}`;
  });
export const sqlString = (value: string) => stringLiteral.encode({ _tag: "StringLiteral", value });
const hasRowid = (table: CreateTable) => !table.options?.includes("WITHOUT ROWID");
const generated = (column: CreateTable["columns"][number]) =>
  column.constraints.some((item) => item._tag === "Generated");
const rowidAlias = (table: CreateTable) =>
  ["rowid", "_rowid_", "oid"].find(
    (name) => !table.columns.some((column) => foldIdentifier(column.name) === name),
  );

/** Return explicit name-based copy columns, including accessible hidden rowids. */
export const rebuildCopy = (
  before: CreateTable,
  after: CreateTable,
): readonly { source: string; target: string }[] | string => {
  const previous = new Map(before.columns.map((column) => [foldIdentifier(column.name), column]));
  const columns = after.columns.flatMap((column) => {
    const old = previous.get(foldIdentifier(column.name));
    return old && !generated(column) ? [{ source: old.name, target: column.name }] : [];
  });
  if (hasRowid(before) && hasRowid(after)) {
    const source = rowidAlias(before);
    const target = rowidAlias(after);
    if (!source || !target) return "Cannot preserve rowids when all rowid aliases are shadowed";
    columns.unshift({ source, target });
  }
  return columns.length
    ? columns
    : "No shared writable columns or rowid are available for copying rows";
};
const autoincrement = (table: CreateTable) =>
  table.columns.some((column) =>
    column.constraints.some((item) => item._tag === "PrimaryKey" && item.autoIncrement),
  );

export const encodeRebuild = (
  operation: RebuildTableOperation,
): Effect.Effect<string, EncodeError> =>
  Effect.gen(function* () {
    const copy = rebuildCopy(operation.before, operation.after);
    if (typeof copy === "string") return yield* Effect.fail(new EncodeError({ message: copy }));
    const table = yield* qualifiedTable(operation.table);
    const replacement = yield* qualifiedTable({
      ...operation.table,
      name: operation.temporaryName,
    });
    const definition = yield* createTable.encode({
      ...operation.after,
      schema: operation.table.schema,
      name: operation.temporaryName,
      temporary: false,
      ifNotExists: false,
    });
    const targets = yield* Effect.forEach(copy, (column) => identifier.encode(column.target));
    const sources = yield* Effect.forEach(copy, (column) => identifier.encode(column.source));
    const statements = [
      definition,
      `INSERT OR ROLLBACK INTO ${replacement} (${targets.join(", ")}) SELECT ${sources.join(", ")} FROM ${table};`,
    ];
    if (autoincrement(operation.before) && autoincrement(operation.after)) {
      const sequence = yield* qualifiedTable({ ...operation.table, name: "sqlite_sequence" });
      const old = yield* sqlString(operation.before.name);
      const fresh = yield* sqlString(operation.temporaryName);
      statements.push(
        `UPDATE ${sequence} SET seq = max(seq, coalesce((SELECT seq FROM ${sequence} WHERE name = ${old} COLLATE NOCASE), 0)) WHERE name = ${fresh};`,
        `INSERT INTO ${sequence} (name, seq) SELECT ${fresh}, seq FROM ${sequence} WHERE name = ${old} COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM ${sequence} WHERE name = ${fresh});`,
      );
    }
    statements.push(
      `DROP TABLE ${table};`,
      `ALTER TABLE ${replacement} RENAME TO ${yield* identifier.encode(operation.after.name)};`,
    );
    return statements.join("\n");
  });
