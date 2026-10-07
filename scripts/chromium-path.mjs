import { existsSync } from "node:fs";

// The Chromium to launch when Playwright can't use its own. Chromium normally
// comes from PLAYWRIGHT_BROWSERS_PATH; in a container whose pinned build
// doesn't match the installed playwright (the launch error names the path it
// wanted), CHROMIUM_PATH is the escape hatch, and the container's preinstalled
// /opt/pw-browsers/chromium is the fallback. Undefined means "let Playwright
// pick", which is what every machine with a matching `playwright install` gets.
//
// `expected` is the executable Playwright would launch — chromium.executablePath().
// Shared by playwright.config.ts and scripts/screenshot_compare.mjs.
export const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";

export function chromiumExecutablePath(expected) {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (expected && existsSync(expected)) return undefined;
  return existsSync(FALLBACK_CHROMIUM) ? FALLBACK_CHROMIUM : undefined;
}
