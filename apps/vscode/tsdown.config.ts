import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  outExtensions: () => ({ js: ".cjs" }),
  deps: { neverBundle: ["vscode"], onlyBundle: ["effect"] },
  platform: "node",
  dts: false,
  clean: true,
});
