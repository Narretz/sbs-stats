import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

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
      // Allow serving files from the project root (needed for public/data/sbs.db)
      allow: ["."],
    },
  },
  plugins: [
    react(),
    {
      // Vite's static handler honours Range requests but doesn't emit
      // `Accept-Ranges: bytes`. sql.js-httpvfs probes for that header via HEAD
      // and falls back to one whole-file fetch when it's absent. Production
      // hosts (R2, S3, CF) send it automatically; in dev we add it ourselves.
      name: "accept-ranges-for-db",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && /\.db(\?|$)/.test(req.url)) {
            res.setHeader("Accept-Ranges", "bytes");
          }
          next();
        });
      },
    },
  ],
}));
