import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  deps: { neverBundle: true },
  exports: { devExports: true },
  format: ["cjs", "esm"],
  platform: "neutral",
  dts: true,
});
