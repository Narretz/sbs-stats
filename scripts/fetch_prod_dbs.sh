#!/usr/bin/env bash
# Download every production DB referenced in .env.production into ./data/.
#
#   scripts/fetch_prod_dbs.sh                  # all of them
#   scripts/fetch_prod_dbs.sh sbs rubikon      # only these: each argument is a
#                                              # DB file name, with or without
#                                              # .db (`ru-attacks-gsua` pulls
#                                              # both its .db and .app.db)
#
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

# Exact names, not substrings: `sbs` must not also pull sbs-units.db.
wanted() {
  [ "${#targets[@]}" -eq 0 ] && return 0
  local name="$1" base="${1%.db}" t
  base="${base%.app}"
  for t in "${targets[@]}"; do
    t="${t%.db}"
    [ "$t" = "$base" ] || [ "$t" = "${name%.db}" ] && return 0
  done
  return 1
}
targets=("$@")
matched=0

failed=()
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
    wanted "$name" || continue
    echo "→ $name"
    # Keep going past a failure — one missing object (a new dataset whose
    # first CI upload hasn't run yet, say) shouldn't cost every DB after it —
    # and report them all at the end. Download beside the target and move it
    # into place only on success, so a failed or cut-off transfer leaves the
    # local copy as it was rather than truncated.
    matched=$((matched + 1))
    if curl --fail --location --show-error --silent --output "data/$name.part" "$variant"; then
      mv "data/$name.part" "data/$name"
    else
      rm -f "data/$name.part"
      failed+=("$name")
    fi
  done
done

if [ "$matched" -eq 0 ]; then
  echo "no DB in .env.production matches: ${targets[*]}" >&2
  exit 1
fi

echo "done — files in data/:"
ls -lh data/*.db

if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED to download ${#failed[@]}: ${failed[*]} (any local copy left as it was)" >&2
  exit 1
fi
