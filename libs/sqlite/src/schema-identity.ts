import type { CreateTable } from "./create-table.ts";
export interface TableIdentity {
  readonly schema: string;
  readonly name: string;
}

// SQLite folds ASCII identifiers. Unicode lowercasing would conflate distinct names.
export const foldIdentifier = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export const tableIdentity = (
  table: Pick<CreateTable, "name" | "schema" | "temporary">,
): TableIdentity => ({
  schema: foldIdentifier(table.schema ?? (table.temporary ? "temp" : "main")),
  name: foldIdentifier(table.name),
});
export const tableKey = (table: TableIdentity) => JSON.stringify([table.schema, table.name]);
