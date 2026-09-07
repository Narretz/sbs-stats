#!/usr/bin/env bash
# Download every production DB referenced in .env.production into ./data/.
# Files land at data/<basename-from-url>. Existing files are overwritten —
# including a locally reparsed DB, so don't run this to "refresh" after a local
# reparse. To rebuild just the stripped copy the frontend reads, without going
# near R2:
#
#   python3 scripts/build_app_db.py --in data/ru-attacks-gsua.db \
#     --out data/ru-attacks-gsua.app.db --blank posts.text
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data

# Grab every VITE_*_DB_URL value from .env.production (ignoring comments/blanks).
# tr -d '\r' strips Windows line endings if the file was checked out as CRLF.
urls=$(grep -E '^VITE_[A-Z_]*DB_URL=' .env.production | sed 's/^[^=]*=//' | tr -d '\r')

for url in $urls; do
  # GSUA / ru-mod-ad publish two objects: the authoritative `<name>.db` with
  # the raw post text, and a stripped `<name>.app.db` the frontend reads. Pull
  # BOTH. Local ingest and reparse need the full text, and `npm run dev` reads
  # the app copy (matching production), so a checkout with only one of them
  # either can't reparse or serves nothing.
  case "$url" in
    *.app.db) variants="${url%.app.db}.db $url" ;;
    *)        variants="$url" ;;
  esac
  for variant in $variants; do
    name=$(basename "$variant")
    echo "→ $name"
    curl --fail --location --show-error --silent --output "data/$name" "$variant"
  done
done

echo "done — files in data/:"
ls -lh data/*.db
