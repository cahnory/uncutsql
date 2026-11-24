import type { CreateTable } from "./create-table.ts";
export interface TableIdentity {
  readonly name: string;
  readonly schema: string;
}

// SQLite folds ASCII identifiers. Unicode lowercasing would conflate distinct names.
export const foldIdentifier = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export const tableIdentity = (
  table: Pick<CreateTable, "name" | "schema" | "temporary">,
): TableIdentity => ({
  name: foldIdentifier(table.name),
  schema: foldIdentifier(table.schema ?? (table.temporary ? "temp" : "main")),
});
export const tableKey = (table: TableIdentity) => JSON.stringify([table.schema, table.name]);
