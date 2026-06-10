const fs = require("fs");
const path = require("path");

const vendorDir = path.join("public", "vendor");
const httpvfsDir = path.join(vendorDir, "httpvfs");
const publicDataDir = path.join("public", "data");

fs.mkdirSync(vendorDir, { recursive: true });
fs.mkdirSync(httpvfsDir, { recursive: true });
fs.mkdirSync(publicDataDir, { recursive: true });

// Committed data snapshots (NOT pulled from R2) — copy from data/ into
// public/data/ so vite serves them in dev and bundles them into dist/ on
// production builds. The other scraped datasets live on R2 via
// .env.production URLs and skip this copy.
for (const file of ["sbs.db", "sbu-alfa.db"]) {
  const src = path.join("data", file);
  const dest = path.join(publicDataDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to ${publicDataDir}`);
  }
}

// Plain sql.js for SBS (full DB in-memory).
for (const file of ["sql-wasm.js", "sql-wasm.wasm"]) {
  const src = path.join("node_modules", "sql.js", "dist", file);
  const dest = path.join(vendorDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to ${vendorDir}`);
  }
}

// sql.js-httpvfs (Worker + wasm) for GSUA (range-fetched DB).
for (const file of ["sqlite.worker.js", "sql-wasm.wasm"]) {
  const src = path.join("node_modules", "sql.js-httpvfs", "dist", file);
  const dest = path.join(httpvfsDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to ${httpvfsDir}`);
  }
}