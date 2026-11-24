import type { SourceNode } from "@uncutsql/codec";
import { Effect } from "effect";
import { schema, type Statement } from "./schema.ts";
import { identifier } from "./tokens.ts";
import { uppercaseAscii } from "./lexer/characters.ts";

export interface Span {
  start: number;
  end: number;
}
export interface SchemaSymbol {
  name: string;
  kind: Statement["_tag"] | "Column";
  range: Span;
  selection: Span;
  children: SchemaSymbol[];
}
interface Reference extends Span {
  schema: string;
  table: string;
  column?: string;
}
export interface SchemaDocument {
  symbols: SchemaSymbol[];
  references: Reference[];
  tables: { schema: string; symbol: SchemaSymbol }[];
  diagnostics: (Span & { message: string })[];
}

function* descendants(node: SourceNode, kind: string): Generator<SourceNode> {
  for (const child of node.children) {
    if (child.kind === kind) yield child;
    else yield* descendants(child, kind);
  }
}

export function analyzeSchema(source: string): SchemaDocument {
  const document: SchemaDocument = { symbols: [], references: [], tables: [], diagnostics: [] };
  const parsed = Effect.runSync(Effect.result(schema.decodeWithSourceMap(source)));
  if (parsed._tag === "Failure") {
    const { offset, message } = parsed.failure;
    document.diagnostics.push({ start: offset, end: Math.min(source.length, offset + 1), message });
    return document;
  }
  const nameOf = (node: SourceNode) =>
    Effect.runSync(identifier.decode({ source, offset: node.start })).value;
  for (const [index, statement] of parsed.success.value.entries()) {
    const node = parsed.success.sourceMap[index]!;
    const header = node.children.find((child) => child.kind === "TableReference")!;
    const symbol: SchemaSymbol = {
      name: statement.name,
      kind: statement._tag,
      range: node,
      selection: header.children.at(-1)!,
      children: [],
    };
    document.symbols.push(symbol);
    if (statement._tag === "CreateView") {
      for (const column of node.children
        .filter((child) => child.kind === "Identifier")
        .slice(0, statement.columns?.length ?? 0)) {
        symbol.children.push({
          name: nameOf(column),
          kind: "Column",
          range: column,
          selection: column,
          children: [],
        });
      }
    }
    if (statement._tag !== "CreateTable" && statement._tag !== "CreateTableAs") continue;
    const namespace = statement.schema ?? (statement.temporary ? "temp" : "main");
    document.tables.push({ schema: namespace, symbol });
    for (const column of descendants(node, "ColumnDefinition")) {
      const selection = column.children[0]!;
      symbol.children.push({
        name: nameOf(selection),
        kind: "Column",
        range: column,
        selection,
        children: [],
      });
    }
    for (const clause of descendants(node, "ForeignKeyClause")) {
      const target = clause.children[0]!;
      const table = nameOf(target);
      document.references.push({ start: target.start, end: target.end, schema: namespace, table });
      for (const list of descendants(clause, "ReferencedColumns")) {
        for (const column of descendants(list, "Identifier")) {
          document.references.push({
            start: column.start,
            end: column.end,
            schema: namespace,
            table,
            column: nameOf(column),
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
    if (!equal(schema, reference.schema) || !equal(symbol.name, reference.table)) return [];
    const name = reference.column;
    return name === undefined
      ? [symbol.selection]
      : symbol.children
          .filter((column) => equal(column.name, name))
          .map((column) => column.selection);
  });
}
