#!/usr/bin/env python3
"""
Print a fingerprint of a SQLite DB's contents — schema and every row — for CI
to tell whether a run changed anything worth uploading.

A hash of the SQL dump rather than of the file: the bytes can differ with the
contents equal (a VACUUM, a write transaction that changed nothing, pages laid
out differently by a rebuild), and an upload over an unchanged object is not
free — it overwrites a live R2 object that the frontend range-reads.

A missing file prints `missing`, which compares unequal to any fingerprint, so
a first run (nothing on R2 yet) uploads.

Usage: python3 scripts/db_fingerprint.py path/to.db
"""
import hashlib
import sqlite3
import sys
from pathlib import Path


def fingerprint(path: Path) -> str:
    if not path.exists():
        return "missing"
    h = hashlib.sha256()
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for line in conn.iterdump():
            h.update(line.encode())
            h.update(b"\n")
    finally:
        conn.close()
    return h.hexdigest()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: db_fingerprint.py path/to.db")
    print(fingerprint(Path(sys.argv[1])))
