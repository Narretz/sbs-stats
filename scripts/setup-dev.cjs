const fs = require("fs");
const path = require("path");

const vendorDir = path.join("public", "vendor");

fs.mkdirSync(vendorDir, { recursive: true });

for (const file of ["sql-wasm.js", "sql-wasm.wasm"]) {
  const src = path.join("node_modules", "sql.js", "dist", file);
  const dest = path.join(vendorDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to ${vendorDir}`);
  }
}