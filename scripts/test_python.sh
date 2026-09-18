#!/usr/bin/env bash
# Run every ingest script's test suite — ONE pytest process per directory.
#
#   bash scripts/test_python.sh                  # all of them
#   bash scripts/test_python.sh scripts/rubikon  # just one (or several)
#   PYTEST_ADDOPTS="-x -q" bash scripts/test_python.sh
#
# Why not a plain `pytest scripts/`: the suites cannot share one process, and
# it is not a pytest configuration problem. Every dataset directory has its own
# `parse.py` / `ingest.py` / `test_ingest.py`, and each script puts its OWN
# directory on sys.path so `import parse` resolves when it runs standalone
# (`python3 scripts/rubikon/ingest.py`). In a single process the first `parse`
# imported wins sys.modules for everyone, so scripts/sbu_alfa's test asks for
# `extract_text` and gets scripts/rubikon/parse.py:
#
#   ImportError: cannot import name 'extract_text' from 'parse'
#               (/home/user/sbs-stats/scripts/rubikon/parse.py)
#
# and the run dies with six collection errors before a single test executes.
#
# An `__init__.py` per directory does NOT fix this — it makes it worse. pytest
# then inserts `scripts/` on sys.path instead of the test's own directory, so
# the bare `import ingest` / `import parse` in several suites stops resolving
# at all (`ModuleNotFoundError: No module named 'parse'`) and the per-directory
# runs that work today break too. The sibling-name collision would still be
# there afterwards, because it comes from the scripts' own imports, not from
# how pytest names test modules. Fixing it properly means renaming the shared
# modules or making the ingest scripts package-relative, which would break
# running them as plain files — the thing they are designed for.
#
# One process per directory sidesteps all of it, and is how these suites have
# always been run by hand.
set -uo pipefail

cd "$(dirname "$0")/.."

# Discovered, not listed: a new dataset's suite joins in by existing. `dirname`
# per match, deduplicated, so several test files in one directory are one run.
dirs=()
if [ "$#" -gt 0 ]; then
  dirs=("$@")
else
  while IFS= read -r d; do
    dirs+=("$d")
  done < <(ls scripts/*/test_*.py 2>/dev/null | xargs -n1 dirname | sort -u)
fi

if [ "${#dirs[@]}" -eq 0 ]; then
  echo "no test directories found under scripts/" >&2
  exit 1
fi

failed=()
for d in "${dirs[@]}"; do
  echo "── $d"
  python3 -m pytest "$d" -q || failed+=("$d")
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED (${#failed[@]}/${#dirs[@]}): ${failed[*]}" >&2
  exit 1
fi
echo "all ${#dirs[@]} suite(s) passed"
