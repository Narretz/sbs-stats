import { defineConfig, devices } from "@playwright/test";

// Isolated port so the e2e server never collides with a running `npm run dev`.
const PORT = 5199;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
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
