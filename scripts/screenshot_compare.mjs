#!/usr/bin/env node
// Screenshot the compare page for a given set of (unit, month) columns.
//
//   node scripts/screenshot_compare.mjs sbu-alfa:2026-07 sbu-alfa:2026-08
//   node scripts/screenshot_compare.mjs alfa:07/26 alfa:08/26 --zoom 120
//   node scripts/screenshot_compare.mjs sbs:2026-08 rubikon:2026-08 --theme light --scope
//
// Reads the PRODUCTION DBs out of ./data via the vite dev middleware — the same
// files the deployed site reads — so a screenshot shows real numbers, not the
// e2e fixtures. Run scripts/fetch_prod_dbs.sh first if data/ is empty.
//
// Options
//   --zoom <pct>     browser zoom, default 100. Compensated by the device scale
//                    factor (see --dsf), so zooming out gives the layout more
//                    room per column instead of just shrinking the text.
//   --dsf <n>        device scale factor. Default 100/zoom, so a zoomed-out
//                    shot stays as legible as a 1:1 one. --dsf 1 gives the
//                    literal shrunken render instead.
//   --theme <t>      dark | light. Default dark.
//   --scope          show the per-column scope captions (default hidden)
//   --no-sub         hide sub-category rows (shown by default)
//   --pct <mode>     first | prev — what the % change compares against
//   --full           capture the whole page, not just the table
//   --width <px>     viewport width in CSS px, default 900. The table is fluid,
//                    so a wide viewport spreads the numbers away from their
//                    labels; ~650px is its nowrap floor, below which the
//                    viewport stops mattering.
//   --out <path>     PNG path. Default tmp/compare-<cols>-<timestamp>.png
//   --port <n>       dev server port, default 5173. An already-running server
//                    on that port is reused; otherwise one is started and shut
//                    down again afterwards.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Compare-page entity id → the DB file it needs in data/. Keys match
// COMPARE_ENTITIES in src/compare/registry.ts; the aliases are just typing
// shortcuts for the command line.
const UNITS = {
  sbs: "sbs.db",
  "sbu-alfa": "sbu-alfa.db",
  rubikon: "rubikon.db",
};
const ALIASES = { alfa: "sbu-alfa", sbu: "sbu-alfa", "sbu_alfa": "sbu-alfa", rubicon: "rubikon" };

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// "2026-07" | "07/26" | "07/2026" | "2026/07" → "2026-07". The MM/YY forms are
// how a month gets typed in conversation; the app's URL wants YYYY-MM.
function normalizeMonth(raw, spec) {
  const m = raw.trim();
  let match;
  if ((match = /^(\d{4})[-/](\d{1,2})$/.exec(m))) {
    return `${match[1]}-${String(match[2]).padStart(2, "0")}`;
  }
  if ((match = /^(\d{1,2})[-/](\d{2}|\d{4})$/.exec(m))) {
    const year = match[2].length === 2 ? `20${match[2]}` : match[2];
    return `${year}-${String(match[1]).padStart(2, "0")}`;
  }
  die(`cannot read a month out of "${spec}" — use YYYY-MM or MM/YY`);
}

function parseArgs(argv) {
  const opts = {
    cols: [], zoom: 100, dsf: null, theme: "dark", scope: false, sub: true,
    pct: "first", full: false, width: 900, out: null, port: 5173,
  };
  const want = (i, name) => {
    if (i + 1 >= argv.length) die(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--zoom": opts.zoom = Number(want(i, a)); i++; break;
      case "--dsf": opts.dsf = Number(want(i, a)); i++; break;
      case "--theme": opts.theme = want(i, a); i++; break;
      case "--scope": opts.scope = true; break;
      case "--no-sub": opts.sub = false; break;
      case "--pct": opts.pct = want(i, a); i++; break;
      case "--full": opts.full = true; break;
      case "--width": opts.width = Number(want(i, a)); i++; break;
      case "--out": opts.out = want(i, a); i++; break;
      case "--port": opts.port = Number(want(i, a)); i++; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) die(`unknown option ${a}`);
        opts.cols.push(a);
    }
  }
  return opts;
}

function parseColumn(spec) {
  const [rawUnit, rawMonth] = spec.split(":");
  if (!rawMonth) die(`"${spec}" is not unit:month (e.g. sbu-alfa:2026-07)`);
  const unit = ALIASES[rawUnit.toLowerCase()] ?? rawUnit.toLowerCase();
  if (!(unit in UNITS)) {
    die(`unknown unit "${rawUnit}" — known: ${Object.keys(UNITS).join(", ")} ` +
        `(aliases: ${Object.keys(ALIASES).join(", ")})`);
  }
  return { unit, month: normalizeMonth(rawMonth, spec) };
}

const serverUp = async (port) => {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
};

async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverUp(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// The dev server reads sql.js out of public/vendor (see src/hooks/sqlLoader.ts).
// It is gitignored and normally laid down by the postinstall hook, so a fresh
// checkout that skipped it would load the page and then fail every query.
function ensureVendor() {
  if (existsSync(join(ROOT, "public", "vendor", "sql-wasm.js"))) return;
  console.log("public/vendor missing — running npm run setup-dev");
  const r = spawn("npm", ["run", "setup-dev"], { cwd: ROOT, stdio: "inherit" });
  return new Promise((done, fail) => {
    r.on("exit", (code) => (code === 0 ? done() : fail(new Error("setup-dev failed"))));
  });
}

async function launchBrowser(playwright, dsf, width) {
  // Chromium comes from PLAYWRIGHT_BROWSERS_PATH normally; CHROMIUM_PATH is the
  // escape hatch for a container whose pinned build doesn't match the installed
  // playwright (the launch error names the path it wanted).
  const opts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  let browser;
  try {
    browser = await playwright.chromium.launch(opts);
  } catch (e) {
    const fallback = "/opt/pw-browsers/chromium";
    if (opts.executablePath || !existsSync(fallback)) throw e;
    browser = await playwright.chromium.launch({ executablePath: fallback });
  }
  return {
    browser,
    context: await browser.newContext({
      viewport: { width, height: 1200 },
      deviceScaleFactor: dsf,
      colorScheme: "dark",
    }),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.cols.length) {
    console.log(
      "usage: node scripts/screenshot_compare.mjs <unit:month> [<unit:month> …] [options]\n" +
      `units: ${Object.keys(UNITS).join(", ")} (aliases: ${Object.keys(ALIASES).join(", ")})\n` +
      "months: YYYY-MM or MM/YY\n" +
      "options: --zoom <pct> --dsf <n> --theme dark|light --scope --no-sub\n" +
      "         --pct first|prev --full --width <px> --out <path> --port <n>\n" +
      "see the comment at the top of this file for what each one does",
    );
    process.exit(opts.help ? 0 : 1);
  }
  if (!["dark", "light"].includes(opts.theme)) die(`--theme must be dark or light`);
  if (!["first", "prev"].includes(opts.pct)) die(`--pct must be first or prev`);
  if (!Number.isFinite(opts.zoom) || opts.zoom <= 0) die("--zoom must be a positive number");

  const columns = opts.cols.map(parseColumn);

  // Production data, not fixtures — fail loudly rather than screenshotting an
  // empty table, which looks like a bug in the page.
  const missing = [...new Set(columns.map((c) => UNITS[c.unit]))]
    .filter((f) => !existsSync(join(ROOT, "data", f)));
  if (missing.length) {
    die(`data/ is missing ${missing.join(", ")} — run scripts/fetch_prod_dbs.sh ` +
        `(or curl just those objects from the R2 base URL in .env.production)`);
  }

  await ensureVendor();

  // Reuse a dev server that is already up; otherwise run one for this shot.
  let devProc = null;
  if (await serverUp(opts.port)) {
    console.log(`reusing dev server on :${opts.port}`);
  } else {
    console.log(`starting dev server on :${opts.port}`);
    devProc = spawn("npm", ["run", "dev", "--", "--port", String(opts.port), "--strictPort"], {
      cwd: ROOT, stdio: "ignore", detached: true,
    });
    if (!(await waitForServer(opts.port))) {
      devProc.kill("SIGTERM");
      die(`dev server did not come up on :${opts.port}`);
    }
  }

  const dsf = opts.dsf ?? Math.max(1, 100 / opts.zoom);
  const playwright = await import("playwright");
  const { browser, context } = await launchBrowser(playwright, dsf, opts.width);
  // The app reads its theme from localStorage on first render, so it has to be
  // there before the bundle runs — a click on the toggle afterwards would be a
  // second paint and a race with the screenshot.
  await context.addInitScript(
    ([theme]) => { try { localStorage.setItem("theme", theme); } catch { /* ignore */ } },
    [opts.theme],
  );
  const page = await context.newPage();

  const params = new URLSearchParams({
    view: "compare",
    cols: columns.map((c) => `${c.unit}:${c.month}`).join(","),
  });
  if (opts.pct === "prev") params.set("pct", "prev");
  if (opts.scope) params.set("scope", "1");
  if (!opts.sub) params.set("sub", "0");
  const url = `http://localhost:${opts.port}/?${params}`;

  console.log(`→ ${url}`);
  let failed = false;
  page.on("pageerror", (e) => { failed = true; console.error(`page error: ${e.message}`); });
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // The table renders before the DBs resolve, so waiting on the element alone
  // would catch a full row of "—". Wait for real numbers in it instead.
  await page.waitForSelector("table", { timeout: 30000 });
  try {
    await page.waitForFunction(
      () => /\d/.test(document.querySelector("table tbody")?.textContent ?? ""),
      null, { timeout: 30000 },
    );
  } catch {
    die("the table never filled in — is data/ holding the DBs for these units?");
  }
  // Zoom last: it only changes layout, and applying it before the data lands
  // just makes the wait above measure a different layout pass.
  if (opts.zoom !== 100) {
    await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, opts.zoom / 100);
  }
  await page.waitForTimeout(250);   // one frame for the zoomed reflow to settle

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = columns.map((c) => `${c.unit}-${c.month}`).join("_").slice(0, 80);
  const out = resolve(ROOT, opts.out ?? join("tmp", `compare-${slug}-${stamp}.png`));
  mkdirSync(dirname(out), { recursive: true });

  if (opts.full) await page.screenshot({ path: out, fullPage: true });
  else await page.locator("table").screenshot({ path: out });

  await browser.close();
  if (devProc) process.kill(-devProc.pid, "SIGTERM");

  const shot = opts.full ? "page" : "table";
  console.log(
    `wrote ${out}\n` +
    `  ${shot} · ${opts.theme} · zoom ${opts.zoom}% · dsf ${dsf} · ` +
    `${columns.map((c) => `${c.unit} ${c.month}`).join(" vs ")}`,
  );
  if (failed) console.error("note: the page logged an error — check the shot before trusting it");
}

main().catch((e) => { console.error(e); process.exit(1); });
