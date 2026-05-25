#!/usr/bin/env bash
#
# run_local.sh — run the GSUA update pipeline locally, in one go.
#
# Mirrors .github/workflows/update-gsua-db.yml, but meant to run from a
# residential IP (Facebook login-walls datacenter IPs like GitHub Actions
# runners — see scripts/gsua/doc.md). Steps:
#   1. download the current DB from R2
#   2. compute the scrape cutoff (latest stored report date − lookback)
#   3. scrape via the Nitter → Facebook path
#   4. upload the DB back to R2
#
# Prereqs:
#   - Python deps installed:  pip install -r ../requirements.txt
#   - Playwright browser:     python -m playwright install chromium
#   - wrangler auth: either `wrangler login`, or export CLOUDFLARE_API_TOKEN
#     and CLOUDFLARE_ACCOUNT_ID in your shell.
#
# Config (override by exporting before running):
#   R2_BUCKET           default: russia-ukraine-war
#   GSUA_DB_NAME        default: ru-attacks-gsua.db
#   GSUA_LOOKBACK_DAYS  default: 2
#
# Usage (each step — download / scrape / upload — is independently skippable):
#   ./run_local.sh                              # download → scrape → upload
#   ./run_local.sh --no-upload                  # download → scrape, no upload
#   ./run_local.sh --no-download                # scrape existing local DB → upload
#   ./run_local.sh --no-scrape                  # download → upload (refresh local, no fetch)
#   ./run_local.sh --no-download --no-scrape    # upload existing local DB as-is
#   ./run_local.sh --since 2026-05-01           # force an explicit cutoff date

set -euo pipefail

# Resolve our own absolute path before cd (used by --help).
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
# Always operate relative to this script's directory (scripts/gsua), so the
# scraper's import + its output/$GSUA_DB_NAME relative path resolve correctly.
cd "$(dirname "$0")"

R2_BUCKET="${R2_BUCKET:-russia-ukraine-war}"
GSUA_DB_NAME="${GSUA_DB_NAME:-ru-attacks-gsua.db}"
GSUA_LOOKBACK_DAYS="${GSUA_LOOKBACK_DAYS:-2}"
export GSUA_DB_NAME  # scraper reads gs.DB_PATH from this

DB_LOCAL="output/$GSUA_DB_NAME"
WRANGLER="npx --yes wrangler@4"

NO_UPLOAD=0
NO_DOWNLOAD=0
NO_SCRAPE=0
FORCE_SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-upload) NO_UPLOAD=1; shift ;;
    --no-download) NO_DOWNLOAD=1; shift ;;
    --no-scrape) NO_SCRAPE=1; shift ;;
    --since) FORCE_SINCE="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$SELF"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p output

if [ "$NO_DOWNLOAD" -eq 1 ]; then
  echo "==> [1/4] Skipping download (--no-download); using existing $DB_LOCAL"
  if [ ! -f "$DB_LOCAL" ]; then
    echo "error: $DB_LOCAL not found — nothing to scrape into / upload" >&2
    exit 1
  fi
else
  echo "==> [1/4] Downloading $R2_BUCKET/$GSUA_DB_NAME from R2"
  $WRANGLER r2 object get "$R2_BUCKET/$GSUA_DB_NAME" --file "$DB_LOCAL" --remote
fi

if [ "$NO_SCRAPE" -eq 1 ]; then
  echo "==> [2-3/4] Skipping cutoff + scrape (--no-scrape)"
else
  if [ -n "$FORCE_SINCE" ]; then
    SINCE="$FORCE_SINCE"
  else
    echo "==> [2/4] Computing cutoff (latest date − ${GSUA_LOOKBACK_DAYS}d)"
    SINCE=$(DB_PATH="$DB_LOCAL" python3 - <<'PY'
import os, sqlite3, datetime
c = sqlite3.connect(os.environ["DB_PATH"])
row = c.execute("SELECT MAX(date) FROM posts").fetchone()
latest = row[0] if row and row[0] else "2024-05-13"
lookback = int(os.environ.get("GSUA_LOOKBACK_DAYS", "2"))
print((datetime.date.fromisoformat(latest) - datetime.timedelta(days=lookback)).isoformat())
PY
    )
  fi
  echo "    cutoff: --since $SINCE"

  echo "==> [3/4] Scraping (Nitter → Facebook) since $SINCE"
  python3 scrape_twitter.py ingest --since "$SINCE"
fi

if [ "$NO_UPLOAD" -eq 1 ]; then
  echo "==> [4/4] Skipping upload (--no-upload). DB left at $DB_LOCAL"
else
  echo "==> [4/4] Uploading $DB_LOCAL → $R2_BUCKET/$GSUA_DB_NAME"
  $WRANGLER r2 object put "$R2_BUCKET/$GSUA_DB_NAME" \
    --file "$DB_LOCAL" \
    --content-type application/vnd.sqlite3 \
    --remote
fi

echo "==> Done."
