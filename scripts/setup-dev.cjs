const fs = require("fs");
const path = require("path");

const vendorDir = path.join("public", "vendor");
const httpvfsDir = path.join(vendorDir, "httpvfs");

fs.mkdirSync(vendorDir, { recursive: true });
fs.mkdirSync(httpvfsDir, { recursive: true });

// `/data/*.db` is served straight from the project's `data/` directory by a
// dev-server middleware in vite.config.ts; no copy into `public/data/` is
// needed. In production the frontend reads from R2 via VITE_*_DB_URL env vars.

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

// Point git at the versioned hooks in .githooks/ (pre-push runs the suite).
// .git/hooks isn't versioned, so core.hooksPath is what makes a hook arrive
// with a clone instead of having to be installed by hand.
//
// Skipped in CI, which never pushes, and skipped if the repo already has a
// hooksPath set to something else — that's someone's deliberate choice and
// silently taking it over would disable their hooks.
// A hooksPath pointing at the repo's own .git/hooks is git's default spelled
// out, so on its own it expresses no preference — some tooling writes it. Only
// treat it as a real choice if somebody has actually put a hook there; the
// shipped .sample files don't run and don't count.
function isVestigial(hooksPath, gitDir) {
  if (path.resolve(hooksPath) !== path.join(gitDir, "hooks")) return false;
  return !fs
    .readdirSync(path.resolve(hooksPath))
    .some((f) => !f.endsWith(".sample"));
}

if (!process.env.CI) {
  const { execFileSync } = require("child_process");
  const git = (args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    git(["rev-parse", "--git-dir"]);
    let current = "";
    try {
      current = git(["config", "--get", "core.hooksPath"]);
    } catch {
      // Unset — `git config --get` exits 1, which is the common case.
    }
    if (current === "" || isVestigial(current, git(["rev-parse", "--absolute-git-dir"]))) {
      git(["config", "core.hooksPath", ".githooks"]);
      console.log("Set core.hooksPath to .githooks (pre-push runs the test suite)");
    } else if (current !== ".githooks") {
      console.log(`Left core.hooksPath as ${current}; .githooks/pre-push not installed`);
    }
  } catch {
    // Not a git work tree (a tarball install, say) — nothing to wire up.
  }
}
