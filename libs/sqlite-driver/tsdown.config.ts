import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: { neverBundle: true },
  dts: true,
  entry: ["src/index.ts"],
  exports: { devExports: true },
  format: ["cjs", "esm"],
  platform: "neutral",
});
