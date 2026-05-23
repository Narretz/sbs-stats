import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Update to match your GitHub repo name
const REPO_NAME = "sbs-stats";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
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
}));
