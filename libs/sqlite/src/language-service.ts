import { Effect } from "effect";

import type { SourceNode } from "@uncutsql/codec";

import { nameIdentifier } from "./codecs/identifier.ts";
import { uppercaseAscii } from "./lexer/characters.ts";
import { schema } from "./schema.ts";
import type { Statement } from "./schema.ts";

export interface Span {
  end: number;
  start: number;
}
export interface SchemaSymbol {
  children: SchemaSymbol[];
  kind: Statement["_tag"] | "Column";
  name: string;
  range: Span;
  selection: Span;
}
interface Reference extends Span {
  column?: string;
  schema: string;
  table: string;
}
export interface SchemaDocument {
  diagnostics: (Span & { message: string })[];
  references: Reference[];
  symbols: SchemaSymbol[];
  tables: { schema: string; symbol: SchemaSymbol }[];
}

function* descendants(node: SourceNode, kind: string): Generator<SourceNode> {
  for (const child of node.children) {
    if (child.kind === kind) {
      yield child;
    } else {
      yield* descendants(child, kind);
    }
  }
}

export function analyzeSchema(source: string): SchemaDocument {
  const document: SchemaDocument = { diagnostics: [], references: [], symbols: [], tables: [] };
  const parsed = Effect.runSync(Effect.result(schema.decodeWithSourceMap(source)));
  if (parsed._tag === "Failure") {
    const { message, offset } = parsed.failure;
    document.diagnostics.push({ end: Math.min(source.length, offset + 1), message, start: offset });
    return document;
  }
  const nameOf = (node: SourceNode) =>
    Effect.runSync(nameIdentifier.decode({ offset: node.start, source })).value;
  for (const [index, statement] of parsed.success.value.entries()) {
    const node = parsed.success.sourceMap[index]!;
    const header = node.children.find((child) => child.kind === "TableReference")!;
    const symbol: SchemaSymbol = {
      children: [],
      kind: statement._tag,
      name: statement.name,
      range: node,
      selection: header.children.at(-1)!,
    };
    document.symbols.push(symbol);
    if (statement._tag === "CreateView") {
      for (const column of node.children
        .filter((child) => child.kind === "Identifier")
        .slice(0, statement.columns?.length ?? 0)) {
        symbol.children.push({
          children: [],
          kind: "Column",
          name: nameOf(column),
          range: column,
          selection: column,
        });
      }
    }
    if (statement._tag !== "CreateTable" && statement._tag !== "CreateTableAs") {
      continue;
    }
    const namespace = statement.schema ?? (statement.temporary ? "temp" : "main");
    document.tables.push({ schema: namespace, symbol });
    for (const column of descendants(node, "ColumnDefinition")) {
      const selection = column.children[0]!;
      symbol.children.push({
        children: [],
        kind: "Column",
        name: nameOf(selection),
        range: column,
        selection,
      });
    }
    for (const clause of descendants(node, "ForeignKeyClause")) {
      const target = clause.children[0]!;
      const table = nameOf(target);
      document.references.push({ end: target.end, schema: namespace, start: target.start, table });
      for (const list of descendants(clause, "ReferencedColumns")) {
        for (const column of descendants(list, "Identifier")) {
          document.references.push({
            column: nameOf(column),
            end: column.end,
            schema: namespace,
            start: column.start,
            table,
          });
        }
      }
    }
  }
  return document;
}

export function referenceAt(document: SchemaDocument, offset: number) {
  return document.references.find((ref) => ref.start <= offset && offset < ref.end);
}

export function definitions(reference: Reference, document: SchemaDocument): Span[] {
  const equal = (left: string, right: string) => uppercaseAscii(left) === uppercaseAscii(right);
  return document.tables.flatMap(({ schema, symbol }) => {
    if (!equal(schema, reference.schema) || !equal(symbol.name, reference.table)) {
      return [];
    }
    const name = reference.column;
    return name === undefined
      ? [symbol.selection]
      : symbol.children
          .filter((column) => equal(column.name, name))
          .map((column) => column.selection);
  });
}
