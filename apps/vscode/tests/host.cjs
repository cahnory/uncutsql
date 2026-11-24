const assert = require("node:assert/strict");
const vscode = require("vscode");

exports.run = async () => {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const file = (path) => vscode.Uri.joinPath(root, path);
  const users = file("schema/users.uncut.sql");
  const posts = await vscode.workspace.openTextDocument(file("schema/blog/posts.uncut.sql"));
  await vscode.extensions.getExtension("uncutsql.uncutsql-vscode").activate();
  const fk = posts.getText().indexOf("REFERENCES users(id)") + "REFERENCES ".length;
  async function navigate(displacement) {
    for (const [offset, line, start, end] of [
      [fk, 0, 13, 18],
      [fk + 6, 1, 2, 4],
    ]) {
      const result = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        posts.uri,
        posts.positionAt(offset),
      );
      assert.equal(result.length, 1);
      assert.equal(result[0].uri.fsPath, users.fsPath);
      assert.ok(
        result[0].range.isEqual(
          new vscode.Range(line + displacement, start, line + displacement, end),
        ),
      );
    }
  }
  await navigate(0);
  assert.ok(!vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === users.fsPath));
  const target = await vscode.workspace.openTextDocument(users);
  const insert = new vscode.WorkspaceEdit();
  insert.insert(users, new vscode.Position(0, 0), "-- unsaved\n\n");
  assert.ok(await vscode.workspace.applyEdit(insert));
  assert.ok(target.isDirty);
  await navigate(2);
  const outline = await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    users,
  );
  assert.equal(outline[0].name, "users");
  assert.deepEqual(
    outline[0].children.map((column) => column.name),
    ["id", "name", "status"],
  );
  const eof = target.positionAt(target.getText().length);
  const broken = new vscode.WorkspaceEdit();
  broken.insert(users, eof, "CREATE TABLE");
  assert.ok(await vscode.workspace.applyEdit(broken));
  async function waitForDiagnostics(count) {
    for (let i = 0; i < 100; i++) {
      const diagnostics = vscode.languages
        .getDiagnostics(users)
        .filter((d) => d.source === "UncutSQL");
      if (diagnostics.length === count) return diagnostics;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("Timed out waiting for diagnostics");
  }
  const [error] = await waitForDiagnostics(1);
  assert.ok(error.range.start.isEqual(target.positionAt(target.getText().length)));
  const repair = new vscode.WorkspaceEdit();
  repair.delete(users, new vscode.Range(eof, target.positionAt(target.getText().length)));
  assert.ok(await vscode.workspace.applyEdit(repair));
  await waitForDiagnostics(0);
  await vscode.workspace.fs.writeFile(file("host-tests-passed"), new Uint8Array());
};
