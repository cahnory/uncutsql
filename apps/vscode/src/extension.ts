import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import { Effect } from "effect";
import * as vscode from "vscode";

import { resolveConfig, schemaFiles } from "@uncutsql/cli";
import { analyzeSchema, definitions, referenceAt } from "@uncutsql/sqlite/language-service";
import type { SchemaSymbol, Span } from "@uncutsql/sqlite/language-service";

const selector: vscode.DocumentSelector = { language: "sql", scheme: "file" };
const matches = (doc: vscode.TextDocument) => vscode.languages.match(selector, doc) > 0;
const range = (doc: vscode.TextDocument, span: Span) =>
  new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));

async function schemaPath(doc: vscode.TextDocument) {
  const path = doc.uri.fsPath;
  const fallback = path.endsWith(".uncut.sql") ? path : undefined;
  const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  if (!root) {
    return fallback;
  }
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const config = await Effect.runPromise(resolveConfig({}, directory));
    if (config.configured) {
      if (config.dialect && config.dialect.specifier !== "@uncutsql/sqlite") {
        return undefined;
      }
      if (!config.schema) {
        return fallback;
      }
      if (path === config.schema) {
        return path;
      }
      const child = relative(config.schema, path);
      if (!fallback || child.startsWith(".." + sep) || child === ".." || isAbsolute(child)) {
        return undefined;
      }
      return (await stat(config.schema)).isDirectory() ? config.schema : undefined;
    }
    if (directory === root || directory === dirname(directory)) {
      return fallback;
    }
  }
}

const kinds = {
  Column: vscode.SymbolKind.Field,
  CreateIndex: vscode.SymbolKind.Key,
  CreateTable: vscode.SymbolKind.Struct,
  CreateTableAs: vscode.SymbolKind.Struct,
  CreateTrigger: vscode.SymbolKind.Event,
  CreateView: vscode.SymbolKind.Interface,
};

function outline(doc: vscode.TextDocument, symbol: SchemaSymbol): vscode.DocumentSymbol {
  const entry = new vscode.DocumentSymbol(
    symbol.name,
    "",
    kinds[symbol.kind],
    range(doc, symbol.range),
    range(doc, symbol.selection),
  );
  entry.children = symbol.children.map((child) => outline(doc, child));
  return entry;
}

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection("uncutsql");
  const cache = new WeakMap<
    vscode.TextDocument,
    { parsed: ReturnType<typeof analyzeSchema>; version: number }
  >();
  function analysis(doc: vscode.TextDocument) {
    const previous = cache.get(doc);
    if (previous?.version === doc.version) {
      return previous.parsed;
    }
    const parsed = analyzeSchema(doc.getText());
    cache.set(doc, { parsed, version: doc.version });
    return parsed;
  }
  const pending = new WeakMap<vscode.TextDocument, object>();
  async function refresh(doc: vscode.TextDocument) {
    if (!matches(doc)) {
      return;
    }
    const request = {};
    pending.set(doc, request);
    try {
      const path = await schemaPath(doc);
      if (pending.get(doc) !== request || doc.isClosed) {
        return;
      }
      diagnostics.set(
        doc.uri,
        path
          ? analysis(doc).diagnostics.map((error) => {
              const diagnostic = new vscode.Diagnostic(
                range(doc, error),
                error.message,
                vscode.DiagnosticSeverity.Error,
              );
              diagnostic.source = "UncutSQL";
              return diagnostic;
            })
          : [],
      );
    } catch (error) {
      if (pending.get(doc) === request && !doc.isClosed) {
        diagnostics.delete(doc.uri);
      }
      console.error(error);
    }
  }
  const refreshAll = () => vscode.workspace.textDocuments.forEach((doc) => void refresh(doc));
  const configs = vscode.workspace.createFileSystemWatcher(
    "**/{package.json,.uncutsqlrc.json,uncutsql.config.*}",
  );
  context.subscriptions.push(
    diagnostics,
    configs,
    configs.onDidCreate(refreshAll),
    configs.onDidChange(refreshAll),
    configs.onDidDelete(refreshAll),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshAll),
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      pending.delete(doc);
      diagnostics.delete(doc.uri);
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      async provideDocumentSymbols(doc) {
        if (await schemaPath(doc)) {
          return analysis(doc).symbols.map((symbol) => outline(doc, symbol));
        }
        return undefined;
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(doc, position, token) {
        const path = await schemaPath(doc);
        if (!path) {
          return;
        }
        const reference = referenceAt(analysis(doc), doc.offsetAt(position));
        if (!reference) {
          return;
        }
        const locations: vscode.Location[] = [];
        for (const file of await schemaFiles(path)) {
          if (token.isCancellationRequested) {
            return;
          }
          const uri = vscode.Uri.file(file);
          const target = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === file);
          if (target) {
            for (const span of definitions(reference, analysis(target))) {
              locations.push(new vscode.Location(uri, range(target, span)));
            }
            continue;
          }
          const diskText = await readFile(file, "utf8");
          const parsed = analyzeSchema(diskText);
          const positionAt = (offset: number) => {
            const lines = diskText.slice(0, offset).split(/\r\n|\r|\n/);
            return new vscode.Position(lines.length - 1, lines.at(-1)!.length);
          };
          for (const span of definitions(reference, parsed)) {
            locations.push(
              new vscode.Location(
                uri,
                new vscode.Range(positionAt(span.start), positionAt(span.end)),
              ),
            );
          }
        }
        return locations;
      },
    }),
  );
  refreshAll();
}
