#!/usr/bin/env bash
# Download every production DB referenced in .env.production into ./data/.
# Files land at data/<basename-from-url>. Existing files are overwritten.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data

# Grab every VITE_*_DB_URL value from .env.production (ignoring comments/blanks).
# tr -d '\r' strips Windows line endings if the file was checked out as CRLF.
urls=$(grep -E '^VITE_[A-Z_]*DB_URL=' .env.production | sed 's/^[^=]*=//' | tr -d '\r')

for url in $urls; do
  name=$(basename "$url")
  echo "→ $name"
  curl --fail --location --show-error --silent --output "data/$name" "$url"
done

echo "done — files in data/:"
ls -lh data/*.db
