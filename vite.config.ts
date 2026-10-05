import { defineConfig, loadEnv, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { createReadStream, statSync } from "node:fs";
import { dirname, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Update to match your GitHub repo name
const REPO_NAME = "sbs-stats";

// Build-time switch for a dataset we back up but may not redistribute
// (src/sites/uaLossesRuMod): without SHOW_UA_LOSSES_RU_MOD=true its import
// resolves to an empty stub, so the build leaves its code out entirely rather
// than hiding it. Not a VITE_ variable — it decides what gets built, and the
// app has no business reading it. Set in .env.development; unset in
// production, e2e and the vitest run.
const gatedDataset = (env: Record<string, string>) =>
  fileURLToPath(new URL(
    env.SHOW_UA_LOSSES_RU_MOD === "true" ? "./src/sites/uaLossesRuMod/index.tsx" : "./src/sites/uaLossesRuMod/off.ts",
    import.meta.url,
  ));

// Middleware streaming `<dir>/<name>.db` for a URL `pattern` whose first group
// is the file name. Emits `Accept-Ranges: bytes` (sql.js-httpvfs probes it via
// HEAD and falls back to a whole-file fetch when absent — R2/S3/CF send it in
// prod) and supports a single `Range: bytes=START-END` header (what
// sql.js-httpvfs sends); other Range forms fall through.
function serveDbs(pattern: RegExp, dir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = pattern.exec(req.url ?? "");
    if (!match) return next();
    const filePath = join(dir, match[1]);
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return next();
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "application/octet-stream");
    const range = req.headers.range;
    const rangeMatch = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = rangeMatch[2] ? Number(rangeMatch[2]) : size - 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", String(size));
      res.end();
      return;
    }
    res.setHeader("Content-Length", String(size));
    createReadStream(filePath).pipe(res);
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? `/${REPO_NAME}/` : "/",
  resolve: {
    // Ordered: the exact gated import before the general `@` prefix.
    alias: [
      { find: /^@\/sites\/uaLossesRuMod$/, replacement: gatedDataset(loadEnv(mode, projectRoot, "")) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  optimizeDeps: {
    exclude: ["sql.js"],
  },
  server: {
    host: true,
    fs: {
      // Allow serving files from the project root (the serve-data-dbs plugin
      // streams DBs out of ./data/).
      allow: ["."],
    },
  },
  plugins: [
    react(),
    {
      // Serve `/data/*.db` straight from the project's `data/` directory in
      // dev, so a fresh `scripts/fetch_prod_dbs.sh` is picked up on refresh
      // without copying files into `public/data/`.
      name: "serve-data-dbs",
      configureServer(server) {
        server.middlewares.use(serveDbs(/^\/data\/([^/?]+\.db)(?:\?|$)/, join(projectRoot, "data")));
      },
      // The e2e suite runs against a build served by `vite preview`, which only
      // serves the build output — not the fixture DBs the dev server reads
      // straight off the project root.
      configurePreviewServer(server) {
        server.middlewares.use(serveDbs(/^\/e2e\/fixtures\/([^/?]+\.db)(?:\?|$)/, join(projectRoot, "e2e", "fixtures")));
      },
    },
  ],
}));
