import type { SchemaValue } from "@uncutsql/core";
export const semanticValue = (value: unknown): SchemaValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(semanticValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key === "_tag" ? "kind" : key, semanticValue(item)]),
    );
  }
  throw new TypeError("Schema model values must be serializable");
};
export const syntaxValue = (value: SchemaValue): unknown => {
  if (Array.isArray(value)) {
    return value.map(syntaxValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key === "kind" ? "_tag" : key,
        syntaxValue(item),
      ]),
    );
  }
  return value;
};
