import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "uncutsql-vscode-"));
try {
  const workspace = join(directory, "multipart");
  await cp("../demo/examples/multipart", workspace, { recursive: true });
  // A same-named declaration outside config.schema must never become an F12 target.
  await writeFile(join(workspace, "decoy.uncut.sql"), "CREATE TABLE users (id INT);");
  const result = spawnSync(
    process.env.VSCODE_CLI ?? "code",
    [
      "--new-window",
      "--wait",
      "--disable-extensions",
      "--disable-workspace-trust",
      "--user-data-dir",
      join(directory, "profile"),
      "--extensions-dir",
      join(directory, "extensions"),
      "--extensionDevelopmentPath=" + resolve("."),
      "--extensionTestsPath=" + resolve("tests/host.cjs"),
      workspace,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("VS Code exited with status " + result.status);
  await access(join(workspace, "host-tests-passed"));
  console.log("VS Code verified foreign key navigation, Outline and diagnostics.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
