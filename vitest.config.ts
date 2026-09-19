import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Unit tests for the app's pure logic — URL codecs, the compare registry's
// value arithmetic, the date/window helpers. Kept separate from
// playwright.config.ts, which drives the real browser: anything needing a DOM,
// a database or recharts belongs in e2e/, and these run in plain Node so they
// stay fast enough to use while editing.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Co-located with the module under test. `e2e/` is Playwright's and must
    // not be picked up here — its `test()` comes from a different runner.
    include: ["src/**/*.test.ts"],
  },
});
