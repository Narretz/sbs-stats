import { defineConfig, devices } from "@playwright/test";

// Isolated port so the e2e server never collides with a running `npm run dev`.
const PORT = 5199;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Nothing in the suite is order-dependent — no beforeAll, no describe.serial,
  // no shared page — and the app is read-only against static fixture DBs, so
  // tests can run concurrently. Two workers, not more: the work is CPU-bound
  // (sql.js/wasm + recharts), so on a 4-core box 2 workers cut the suite 2.4m →
  // 1.5m for only ~23% more total test time, while 4 workers buy a further 6s
  // of wall clock for 2.2x the contention — and stretch the slowest test from
  // 14s to 25s, eating most of the 60s timeout below.
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  // Build the synthetic fixtures, then serve in `e2e` mode (.env.e2e points the
  // app at those fixtures). Both run before the URL is polled, so ordering holds.
  webServer: {
    command: `node e2e/build-fixtures.mjs && npx vite --mode e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
