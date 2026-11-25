import { open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";

import type { ConfigSource } from "./config.ts";

export async function configUpdate(
  source: ConfigSource | undefined,
  changes: Record<string, unknown>,
) {
  if (!source) {
    return JSON.stringify(changes, null, 2) + "\n";
  }
  const { path, text } = source;
  if (path.endsWith(".json")) {
    const document = JSON.parse(text);
    Object.assign(source.manifest ? (document.uncutsql ??= {}) : document, changes);
    const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
    return (
      JSON.stringify(document, null, indent).replaceAll(
        "\n",
        text.includes("\r\n") ? "\r\n" : "\n",
      ) + (text.match(/\r?\n$/)?.[0] ?? "")
    );
  }

  // Keep executable config expressions, imports and comments intact.
  const ts = await import("typescript");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const assignment = file.statements.find(ts.isExportAssignment);
  const withChanges = (base: string) =>
    "{\n  ...(" + base + "),\n" + JSON.stringify(changes, null, 2).slice(2);
  if (assignment) {
    const expression = assignment.expression;
    const start = expression.getStart(file);
    return (
      text.slice(0, start) +
      withChanges(text.slice(start, expression.end)) +
      text.slice(expression.end)
    );
  }
  for (const declaration of file.statements) {
    if (!ts.isExportDeclaration(declaration) || !declaration.exportClause) {
      continue;
    }
    const clause = declaration.exportClause;
    if (!ts.isNamedExports(clause)) {
      continue;
    }
    const item = clause.elements.find((element) => element.name.text === "default");
    if (!item) {
      continue;
    }
    const originalName = (item.propertyName ?? item.name).getText(file);
    const remaining = clause.elements
      .filter((element) => element !== item)
      .map((element) => element.getText(file));
    const suffix = text.slice(clause.end, declaration.end);
    let base = originalName;
    let replacement = remaining.length ? `export { ${remaining.join(", ")} }${suffix}` : "";
    if (declaration.moduleSpecifier) {
      base = "uncutsqlBaseConfig";
      while (text.includes(base)) {
        base += "_";
      }
      replacement += `\nimport { ${originalName} as ${base} }${suffix}\n`;
    }
    return (
      text.slice(0, declaration.getStart(file)) +
      replacement +
      text.slice(declaration.end) +
      `\nexport default ${withChanges(base)};\n`
    );
  }
  if (/\.c[jt]s$/.test(path) || !ts.isExternalModule(file)) {
    return text + `\n;module.exports = ${withChanges("module.exports")};\n`;
  }
  throw new Error(`Cannot update ${path}: use an export default expression for the configuration.`);
}

export async function saveConfigUpdate(source: ConfigSource, updated: string) {
  const path = await realpath(source.path);
  const stage = path + ".uncutsql-init.tmp";
  const handle = await open(stage, "wx", 0o600);
  let published = false;
  try {
    if ((await readFile(path, "utf8")) !== source.text) {
      throw new Error(`Configuration changed during initialization: ${path}. Run init again.`);
    }
    await handle.writeFile(updated);
    await handle.chmod((await stat(path)).mode & 0o777);
    await handle.close();
    await rename(stage, path);
    published = true;
  } finally {
    await handle.close();
    if (!published) {
      await unlink(stage);
    }
  }
}
