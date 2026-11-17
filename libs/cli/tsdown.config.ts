import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/api.ts", "src/index.ts"],
  clean: true,
  deps: { neverBundle: true },
  format: ["esm"],
  platform: "node",
  dts: true,
});
