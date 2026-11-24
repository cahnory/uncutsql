/** Serializable semantic values. Dialects normalize their details before comparison. */
export type SchemaValue =
  | null
  | boolean
  | number
  | string
  | readonly SchemaValue[]
  | { readonly [key: string]: SchemaValue };

/** Keys are already normalized by the dialect. Core never folds or resolves names. */
export interface TableIdentity {
  readonly catalog?: string;
  readonly schema?: string;
  readonly name: string;
}

export interface Constraint {
  readonly kind: string;
  readonly properties: { readonly [key: string]: SchemaValue };
}

export interface DatabaseColumn {
  readonly key: string;
  readonly name: string;
  readonly dataType: SchemaValue;
  readonly constraints: readonly Constraint[];
}

/** Standalone indexes belong to a table; keys are normalized within its namespace. */
export interface DatabaseIndex {
  readonly key: string;
  readonly name: string;
  readonly unique: boolean;
  readonly terms: readonly SchemaValue[];
  readonly where: SchemaValue;
}

export interface DatabaseTable {
  readonly identity: TableIdentity;
  readonly name: string;
  readonly columns: readonly DatabaseColumn[];
  readonly indexes?: readonly DatabaseIndex[];
  readonly constraints: readonly Constraint[];
  /** Namespaced keys retain vendor-specific features without teaching core their meaning. */
  readonly options: { readonly [key: string]: SchemaValue };
}

export interface DatabaseView {
  readonly identity: TableIdentity;
  readonly name: string;
  readonly columns?: readonly string[];
  readonly query: SchemaValue;
}

export interface DatabaseSchema {
  readonly views?: readonly DatabaseView[];
  readonly tables: readonly DatabaseTable[];
}

export const tableKey = (table: TableIdentity): string =>
  JSON.stringify([table.catalog ?? null, table.schema ?? null, table.name]);

/** Object property insertion order is not semantic; array order is retained. */
export const schemaValueEqual = (before: SchemaValue, after: SchemaValue): boolean => {
  if (before === after) return true;
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object")
    return false;
  if (Array.isArray(before) || Array.isArray(after)) {
    return (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((value, index) => schemaValueEqual(value, after[index]!))
    );
  }
  const left = before as { readonly [key: string]: SchemaValue };
  const right = after as { readonly [key: string]: SchemaValue };
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && schemaValueEqual(left[key]!, right[key]!))
  );
};
