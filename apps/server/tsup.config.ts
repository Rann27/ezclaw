import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // Workspace packages ship TypeScript source, so they must be bundled.
  noExternal: [/^@ezclaw\//],
});
