import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: { neverBundle: true },
  dts: true,
  entry: ["src/index.ts", "src/tokens.ts", "src/language-service.ts", "src/create-table.ts"],
  exports: { devExports: true },
  format: ["cjs", "esm"],
  platform: "neutral",
});
