import { Effect } from "effect";

import { EncodeError } from "@uncutsql/codec";

import type { CreateIndex } from "./codecs/create-index.ts";
import { identifier } from "./codecs/identifier.ts";
import { stringLiteral } from "./codecs/string-literal.ts";
import { createTable } from "./create-table.ts";
import type { CreateTable } from "./create-table.ts";
import type { TableIdentity } from "./schema-identity.ts";
import { foldIdentifier } from "./schema-identity.ts";

export interface RebuildTableOperation {
  readonly _tag: "RebuildTable";
  readonly after: CreateTable;
  readonly before: CreateTable;
  readonly indexesBefore?: readonly CreateIndex[];
  readonly renames?: readonly { readonly source: string; readonly target: string }[];
  readonly table: TableIdentity;
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

// Only the exact INTEGER type aliases the rowid. SQLite treats inline
// PRIMARY KEY DESC differently from DESC in a table-level primary key.
const integerPrimaryKey = (table: CreateTable) =>
  table.columns.find((column) => {
    if (!/^(?:integer|'integer'|"integer"|`integer`|\[integer\])$/i.test(column.typeName ?? "")) {
      return false;
    }
    return (
      column.constraints.some((item) => item._tag === "PrimaryKey" && item.order !== "DESC") ||
      table.tableConstraints.some(
        (item) =>
          item._tag === "PrimaryKey" &&
          item.columns.length === 1 &&
          foldIdentifier(item.columns[0]!.column) === foldIdentifier(column.name),
      )
    );
  })?.name;

/** Return explicit name-based copy columns, including accessible hidden rowids. */
export const rebuildCopy = (
  before: CreateTable,
  after: CreateTable,
  renames: readonly { readonly source: string; readonly target: string }[] = [],
): readonly { source: string; target: string }[] | string => {
  const previous = new Map(before.columns.map((column) => [foldIdentifier(column.name), column]));
  const next = new Map(after.columns.map((column) => [foldIdentifier(column.name), column]));
  const mapping = new Map<string, string>();
  const sources = new Set<string>();
  for (const rename of renames) {
    const source = foldIdentifier(rename.source),
      target = foldIdentifier(rename.target);
    const from = previous.get(source);
    const to = next.get(target);
    if (
      !from ||
      !to ||
      previous.has(target) ||
      next.has(source) ||
      mapping.has(target) ||
      sources.has(source)
    ) {
      return "Invalid or conflicting column rename mapping";
    }
    mapping.set(target, source);
    sources.add(source);
  }
  const columns: { source: string; target: string }[] = [];
  for (const column of after.columns) {
    const old = previous.get(
      mapping.get(foldIdentifier(column.name)) ?? foldIdentifier(column.name),
    );
    if (!old) {
      continue;
    }
    if (!generated(column)) {
      columns.push({ source: old.name, target: column.name });
    } else if (!generated(old)) {
      return `Cannot copy ${JSON.stringify(old.name)} into generated column ${JSON.stringify(column.name)}`;
    }
  }
  if (hasRowid(before) && hasRowid(after)) {
    const oldKey = integerPrimaryKey(before);
    const newKey = integerPrimaryKey(after);
    const keyCopy = columns.find((column) => column.target === newKey);
    if (keyCopy) {
      if (keyCopy.source !== oldKey) {
        return `Cannot preserve both the rowid and column ${JSON.stringify(keyCopy.source)} in integer primary key ${JSON.stringify(newKey)}`;
      }
      return columns;
    }
    const source = oldKey ?? rowidAlias(before);
    const target = newKey ?? rowidAlias(after);
    if (!source || !target) {
      return "Cannot preserve rowids when all rowid aliases are shadowed";
    }
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
    const copy = rebuildCopy(operation.before, operation.after, operation.renames);
    if (typeof copy === "string") {
      return yield* Effect.fail(new EncodeError({ message: copy }));
    }
    const table = yield* qualifiedTable(operation.table);
    const replacement = yield* qualifiedTable({
      ...operation.table,
      name: operation.temporaryName,
    });
    const definition = yield* createTable.encode({
      ...operation.after,
      ifNotExists: false,
      name: operation.temporaryName,
      schema: operation.table.schema,
      temporary: false,
    });
    const targets = yield* Effect.forEach(copy, (column) => identifier.encode(column.target));
    const sources = yield* Effect.forEach(copy, (column) => identifier.encode(column.source));
    const statements = [
      definition,
      `INSERT OR ROLLBACK INTO ${replacement} (${targets.join(", ")}) SELECT ${sources.join(", ")} FROM ${table};`,
    ];
    if (autoincrement(operation.before) && autoincrement(operation.after)) {
      const sequence = yield* qualifiedTable({ ...operation.table, name: "sqlite_sequence" });
      const old = yield* sqlString(operation.after.name);
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
