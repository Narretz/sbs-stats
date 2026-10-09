import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { chromium } from "@playwright/test";
import { chromiumExecutablePath } from "./scripts/chromium-path.mjs";

// Two projects, one runner:
//
// - unit (`*.test.ts`): the app's pure logic — URL codecs, the compare
//   registry's value arithmetic, the date/window helpers. Plain Node, so they
//   stay fast enough to use while editing.
// - browser (`*.browser.test.tsx`): one component mounted on its own in a real
//   Chromium — a control's own behaviour (stepping, clamping, debounce, popover
//   placement), with props in and callbacks out. No page, no DB, no fixture
//   build: a page load per case is what makes the same check cost seconds in
//   e2e/.
//
// e2e/ (Playwright, its own config) keeps what needs the real app: a DB
// loading, recharts on real data, the URL and history, page-wide scrolling.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          // Co-located with the module under test. `e2e/` is Playwright's and
          // must not be picked up here — its `test()` comes from a different runner.
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            // Same Chromium resolution as playwright.config.ts.
            provider: playwright({
              launchOptions: { executablePath: chromiumExecutablePath(chromium.executablePath()) },
            }),
            instances: [{ browser: "chromium", viewport: { width: 1000, height: 700 } }],
          },
        },
      },
    ],
  },
});
