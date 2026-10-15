import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shell tools start real processes (PowerShell on Windows), which can take a second or two.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
