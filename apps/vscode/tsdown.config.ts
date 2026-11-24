import { defineConfig } from "tsdown";
export default defineConfig({
  clean: true,
  deps: { neverBundle: ["vscode"], onlyBundle: ["effect"] },
  dts: false,
  entry: ["src/extension.ts"],
  format: ["cjs"],
  outExtensions: () => ({ js: ".cjs" }),
  platform: "node",
});
