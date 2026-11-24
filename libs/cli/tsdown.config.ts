import { defineConfig } from "tsdown";
export default defineConfig({
  clean: true,
  deps: { neverBundle: true },
  dts: true,
  entry: ["src/api.ts", "src/index.ts"],
  format: ["esm"],
  platform: "node",
});
