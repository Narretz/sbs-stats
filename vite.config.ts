import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { createReadStream, statSync } from "node:fs";
import { dirname, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Update to match your GitHub repo name
const REPO_NAME = "sbs-stats";

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? `/${REPO_NAME}/` : "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
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
      // without copying files into `public/data/`. Also emits
      // `Accept-Ranges: bytes` (sql.js-httpvfs probes it via HEAD and falls
      // back to a whole-file fetch when absent — R2/S3/CF send it in prod).
      // Supports a single `Range: bytes=START-END` header (what sql.js-httpvfs
      // sends); other Range forms fall through.
      name: "serve-data-dbs",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url ?? "";
          const match = /^\/data\/([^/?]+\.db)(?:\?|$)/.exec(url);
          if (!match) return next();
          const filePath = join(projectRoot, "data", match[1]);
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
        });
      },
    },
  ],
}));
