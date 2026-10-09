"""db_fingerprint.py: equal for equal contents, whatever the file's bytes."""
import shutil
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db_fingerprint import fingerprint  # noqa: E402


def _db(path, rows):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)")
    conn.executemany("INSERT INTO t VALUES (?, ?)", rows)
    conn.commit()
    conn.close()


def test_same_contents_same_fingerprint_even_after_vacuum(tmp_path):
    a, b = tmp_path / "a.db", tmp_path / "b.db"
    _db(a, [("x", 1), ("y", 2)])
    shutil.copy(a, b)
    conn = sqlite3.connect(b)
    conn.execute("VACUUM")
    conn.close()
    assert fingerprint(a) == fingerprint(b)


def test_a_changed_row_changes_it(tmp_path):
    a, b = tmp_path / "a.db", tmp_path / "b.db"
    _db(a, [("x", 1)])
    _db(b, [("x", 2)])
    assert fingerprint(a) != fingerprint(b)


def test_a_missing_file_never_matches(tmp_path):
    a = tmp_path / "a.db"
    _db(a, [])
    assert fingerprint(tmp_path / "nope.db") == "missing"
    assert fingerprint(a) != "missing"
