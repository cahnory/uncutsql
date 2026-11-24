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
  readonly name: string;
  readonly schema?: string;
}

export interface Constraint {
  readonly kind: string;
  readonly properties: { readonly [key: string]: SchemaValue };
}

export interface DatabaseColumn {
  readonly constraints: readonly Constraint[];
  readonly dataType: SchemaValue;
  readonly key: string;
  readonly name: string;
}

/** Standalone indexes belong to a table; keys are normalized within its namespace. */
export interface DatabaseIndex {
  readonly key: string;
  readonly name: string;
  readonly terms: readonly SchemaValue[];
  readonly unique: boolean;
  readonly where: SchemaValue;
}

export interface DatabaseTable {
  readonly columns: readonly DatabaseColumn[];
  readonly constraints: readonly Constraint[];
  readonly identity: TableIdentity;
  readonly indexes?: readonly DatabaseIndex[];
  readonly name: string;
  /** Namespaced keys retain vendor-specific features without teaching core their meaning. */
  readonly options: { readonly [key: string]: SchemaValue };
}

export interface DatabaseView {
  readonly columns?: readonly string[];
  readonly identity: TableIdentity;
  readonly name: string;
  readonly query: SchemaValue;
}

export interface DatabaseTrigger {
  /** Dialect-normalized timing, event, condition and ordered actions. */
  readonly definition: SchemaValue;
  readonly identity: TableIdentity;
  readonly name: string;
  /** Normalized identity of the table or view that owns this trigger. */
  readonly target: TableIdentity;
}

export interface DatabaseSchema {
  readonly tables: readonly DatabaseTable[];
  readonly triggers?: readonly DatabaseTrigger[];
  readonly views?: readonly DatabaseView[];
}

export const tableKey = (table: TableIdentity): string =>
  JSON.stringify([table.catalog ?? null, table.schema ?? null, table.name]);

/** Object property insertion order is not semantic; array order is retained. */
export const schemaValueEqual = (before: SchemaValue, after: SchemaValue): boolean => {
  if (before === after) {
    return true;
  }
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object"
  ) {
    return false;
  }
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
