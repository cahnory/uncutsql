import { Data, Effect } from "effect";
import type { DatabaseSchema } from "./model.ts";

export class SchemaModelError extends Data.TaggedError("SchemaModelError")<{
  readonly path: string;
  readonly message: string;
}> {}

type RecordValue = Record<string, unknown>;
const fail = (path: string, expected: string): never => {
  throw new SchemaModelError({ path, message: `${path}: expected ${expected}` });
};
const record = (value: unknown, path: string): RecordValue => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail(path, "an object");
  return value as RecordValue;
};
const fields = (value: RecordValue, allowed: readonly string[], path: string) => {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key))
      fail(`${path}.${String(key)}`, "a recognized field");
  }
};
const text = (value: unknown, path: string) => {
  if (typeof value !== "string") fail(path, "a string");
};
const array = (value: unknown, path: string, visit: (item: unknown, path: string) => void) => {
  if (!Array.isArray(value)) return fail(path, "an array");
  for (const [index, item] of value.entries()) visit(item, `${path}[${index}]`);
};
const semanticValue = (value: unknown, path: string, ancestors = new Set<object>()): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value !== "object") return fail(path, "a serializable schema value");
  if (ancestors.has(value)) return fail(path, "an acyclic schema value");
  ancestors.add(value);
  if (Array.isArray(value)) array(value, path, (item, at) => semanticValue(item, at, ancestors));
  else
    for (const key of Reflect.ownKeys(record(value, path))) {
      if (typeof key !== "string") return fail(path, "string property keys");
      semanticValue((value as RecordValue)[key], `${path}.${key}`, ancestors);
    }
  ancestors.delete(value);
};
const properties = (value: unknown, path: string) => {
  record(value, path);
  semanticValue(value, path);
};
const constraint = (value: unknown, path: string) => {
  const item = record(value, path);
  fields(item, ["kind", "properties"], path);
  text(item.kind, `${path}.kind`);
  properties(item.properties, `${path}.properties`);
};
const column = (value: unknown, path: string) => {
  const item = record(value, path);
  fields(item, ["key", "name", "dataType", "constraints"], path);
  text(item.key, `${path}.key`);
  text(item.name, `${path}.name`);
  semanticValue(item.dataType, `${path}.dataType`);
  array(item.constraints, `${path}.constraints`, constraint);
};
const index = (value: unknown, path: string) => {
  const item = record(value, path);
  fields(item, ["key", "name", "unique", "terms", "where"], path);
  text(item.key, `${path}.key`);
  text(item.name, `${path}.name`);
  if (typeof item.unique !== "boolean") fail(`${path}.unique`, "a boolean");
  array(item.terms, `${path}.terms`, semanticValue);
  semanticValue(item.where, `${path}.where`);
};
const table = (value: unknown, path: string) => {
  const item = record(value, path);
  fields(item, ["identity", "name", "columns", "constraints", "options", "indexes"], path);
  const identity = record(item.identity, `${path}.identity`);
  fields(identity, ["catalog", "schema", "name"], `${path}.identity`);
  text(identity.name, `${path}.identity.name`);
  for (const key of ["catalog", "schema"])
    if (Object.hasOwn(identity, key)) text(identity[key], `${path}.identity.${key}`);
  text(item.name, `${path}.name`);
  array(item.columns, `${path}.columns`, column);
  if (Object.hasOwn(item, "indexes")) array(item.indexes, `${path}.indexes`, index);
  array(item.constraints, `${path}.constraints`, constraint);
  properties(item.options, `${path}.options`);
};

/** Validate external/JSON-restored models before core or a dialect consumes them. */
export const decodeDatabaseSchema = (
  value: unknown,
): Effect.Effect<DatabaseSchema, SchemaModelError> =>
  Effect.try({
    try: () => {
      const database = record(value, "$database");
      fields(database, ["tables"], "$database");
      array(database.tables, "$database.tables", table);
      return value as DatabaseSchema;
    },
    catch: (cause) =>
      cause instanceof SchemaModelError
        ? cause
        : new SchemaModelError({ path: "$database", message: "Invalid database model" }),
  });
