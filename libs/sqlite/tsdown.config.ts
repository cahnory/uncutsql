import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/tokens.ts", "src/create-table.ts", "src/node.ts"],
  clean: true,
  deps: { neverBundle: true },
  exports: { devExports: true },
  format: ["cjs", "esm"],
  platform: "neutral",
  dts: true,
});
