#!/usr/bin/env python3
"""Download a dataset's DB from R2 for a CI job — or fail the job.

    python3 scripts/r2_get_db.py russia-ukraine-war/cit-civilians.db data/cit-civilians.db
    python3 scripts/r2_get_db.py <bucket>/<key> <file> --allow-missing   # a new dataset's first run

Every update workflow downloads its DB, adds to it and uploads it back, so a
download that fails while the job carries on is how a dataset's history gets
replaced by one run's worth of rows: wrangler creates `--file` before it
fetches, so after a failed download the ingest finds an empty file, opens it
as an empty DB, fills it from its incremental window and the upload puts that
over the real object.

So this:
  - retries a failed download with backoff, and fails if it keeps failing;
  - fails on a missing object too, unless `--allow-missing` is given — an
    established dataset whose object is gone needs a restore, not a fresh
    start; only a brand-new dataset's first run wants the flag;
  - downloads to `<file>.part` and moves it into place only once it is a
    non-empty SQLite file, so a failed or truncated download never leaves
    anything at `<file>` for the ingest to open.

"Missing" is recognised by wrangler's own message for a 404 ("The specified
key does not exist."), which it prints for nothing else. If a wrangler release
rewords it, a missing object reads as an error and fails the job — the safe way
round.

Stdlib only. `R2_GET_WRANGLER` overrides the wrangler command and
`R2_GET_BACKOFF` the retry delays (seconds, comma-separated); both are for the
tests.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
import time

DEFAULT_WRANGLER = "npx --yes wrangler@4"
DEFAULT_BACKOFF = (10, 30, 60)  # waits between attempts: 4 attempts in all
MISSING_MARKER = "The specified key does not exist."
SQLITE_HEADER = b"SQLite format 3\x00"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_MISSING = 2


def _backoff() -> list[float]:
    raw = os.environ.get("R2_GET_BACKOFF")
    if raw is None:
        return list(DEFAULT_BACKOFF)
    return [float(x) for x in raw.split(",") if x.strip()]


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _is_sqlite(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(SQLITE_HEADER)) == SQLITE_HEADER
    except OSError:
        return False


def fetch(object_path: str, dest: str, allow_missing: bool = False) -> int:
    """Download `object_path` to `dest`. Returns one of the EXIT_* codes."""
    part = dest + ".part"
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    cmd = shlex.split(os.environ.get("R2_GET_WRANGLER", DEFAULT_WRANGLER)) + [
        "r2", "object", "get", object_path, "--file", part, "--remote"]
    waits = _backoff()
    attempts = len(waits) + 1

    for attempt in range(1, attempts + 1):
        _remove(part)
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, errors="replace")
        sys.stderr.write(proc.stdout)

        if proc.returncode == 0:
            if _is_sqlite(part):
                os.replace(part, dest)
                print(f"r2_get_db: {object_path} → {dest} "
                      f"({os.path.getsize(dest):,} bytes)", file=sys.stderr)
                return EXIT_OK
            reason = "download succeeded but is not a SQLite file (empty or truncated?)"
        elif MISSING_MARKER in proc.stdout:
            _remove(part)
            if allow_missing:
                print(f"r2_get_db: {object_path} is not on R2 — starting fresh "
                      "(--allow-missing)", file=sys.stderr)
                return EXIT_OK
            print(f"r2_get_db: {object_path} is not on R2. Refusing to start the "
                  "dataset over: its history lives only there, so a missing object "
                  "means it needs restoring. For a brand-new dataset's first run, "
                  "pass --allow-missing.", file=sys.stderr)
            return EXIT_MISSING
        else:
            reason = f"wrangler exited {proc.returncode}"

        _remove(part)
        if attempt < attempts:
            wait = waits[attempt - 1]
            print(f"r2_get_db: attempt {attempt}/{attempts} failed ({reason}); "
                  f"retrying in {wait:g}s", file=sys.stderr)
            time.sleep(wait)
        else:
            print(f"r2_get_db: giving up on {object_path} after {attempts} attempts "
                  f"({reason}). Failing the job rather than letting the ingest "
                  "run against an empty DB and upload it over the real one.",
                  file=sys.stderr)
    return EXIT_FAILED


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("object", help="<bucket>/<key>")
    ap.add_argument("file", help="where to put it")
    ap.add_argument("--allow-missing", action="store_true",
                    help="a missing object is a fresh start, not an error "
                         "(a new dataset's first run only)")
    args = ap.parse_args(argv)
    return fetch(args.object, args.file, allow_missing=args.allow_missing)


if __name__ == "__main__":
    sys.exit(main())
