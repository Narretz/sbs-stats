#!/usr/bin/env bash
# Backfill ua-losses.db from the full Kaggle version history, oldest→newest, into
# a FRESH db so the append-only snapshots land in chronological order. Each
# version is stamped with its own data vintage as scraped_at (see ingest.py
# --as-of), so diffing snapshots later reconstructs the reclassification history
# (missing → dead / POW) that the source itself doesn't retain.
#
# Requires Kaggle creds in the environment:
#     set -a; . ./.env.kaggle; set +a
#     bash scripts/ua_losses/backfill.sh [OUT_DB]
#
# Note: each version is a ~5–30 MB download; a full backfill of ~19 versions
# takes several minutes.
set -euo pipefail

REF="${UA_LOSSES_KAGGLE_REF:-ol4ubert/confirmed-ukrainian-military-personnel-losses}"
OUT="${1:-data/ua-losses.db}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ -z "${KAGGLE_USERNAME:-}" || -z "${KAGGLE_KEY:-}" ]]; then
  echo "KAGGLE_USERNAME / KAGGLE_KEY must be set (e.g. 'set -a; . ./.env.kaggle; set +a')." >&2
  exit 1
fi

# Current (max) version number, straight from the Kaggle API.
MAX=$(curl -s -u "$KAGGLE_USERNAME:$KAGGLE_KEY" \
  "https://www.kaggle.com/api/v1/datasets/view/$REF" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['currentVersionNumber'])")

echo "Backfilling $MAX versions of $REF into a fresh $OUT"
rm -f "$OUT"
for N in $(seq 1 "$MAX"); do
  echo "──────── version $N / $MAX ────────"
  python3 "$HERE/ingest.py" --version "$N" --out "$OUT"
done
echo "Backfill complete: $OUT"
