const fs = require("fs");
const path = require("path");

const vendorDir = path.join("public", "vendor");
const httpvfsDir = path.join(vendorDir, "httpvfs");

fs.mkdirSync(vendorDir, { recursive: true });
fs.mkdirSync(httpvfsDir, { recursive: true });

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