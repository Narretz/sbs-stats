"""scripts/r2_get_db.py against a stub wrangler that plays out a script of
outcomes, one per attempt."""

import json
import os
import sqlite3
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import r2_get_db  # noqa: E402

STUB = textwrap.dedent("""
    import json, sys
    from pathlib import Path
    script = Path(sys.argv[1])
    args = sys.argv[2:]
    out = args[args.index("--file") + 1]
    state = json.loads(script.read_text())
    outcome = state["outcomes"].pop(0)
    state["calls"] += 1
    script.write_text(json.dumps(state))
    # Like wrangler: the output file exists before the fetch does.
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    open(out, "wb").close()
    if outcome == "ok":
        Path(out).write_bytes(Path(state["source"]).read_bytes())
        sys.exit(0)
    if outcome == "truncated":
        Path(out).write_bytes(b"SQLite")
        sys.exit(0)
    if outcome == "missing":
        print("X [ERROR] The specified key does not exist.")
        sys.exit(1)
    print("X [ERROR] Failed to fetch ... - 500: Internal Server Error;")
    sys.exit(1)
""")


@pytest.fixture
def r2(tmp_path, monkeypatch):
    """Returns play(outcomes) → (exit code, dest path, number of wrangler calls)."""
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as c:
        c.execute("CREATE TABLE reports (id INTEGER)")
        c.execute("INSERT INTO reports VALUES (1)")
    stub = tmp_path / "wrangler_stub.py"
    stub.write_text(STUB)
    script = tmp_path / "script.json"
    monkeypatch.setenv("R2_GET_WRANGLER", f"{sys.executable} {stub} {script}")
    monkeypatch.setenv("R2_GET_BACKOFF", "0,0,0")

    def play(outcomes, allow_missing=False, dest=None):
        dest = dest or tmp_path / "data" / "x.db"
        script.write_text(json.dumps(
            {"outcomes": list(outcomes), "calls": 0, "source": str(source)}))
        code = r2_get_db.fetch("bucket/x.db", str(dest), allow_missing=allow_missing)
        return code, dest, json.loads(script.read_text())["calls"]
    return play


def _rows(path):
    with sqlite3.connect(path) as c:
        return c.execute("SELECT COUNT(*) FROM reports").fetchone()[0]


def test_success_lands_the_db(r2):
    code, dest, calls = r2(["ok"])
    assert (code, calls) == (0, 1)
    assert _rows(dest) == 1
    assert not Path(str(dest) + ".part").exists()


def test_a_transient_error_is_retried(r2):
    # A one-off 500 from R2 should cost a retry, not the job.
    code, dest, calls = r2(["error", "ok"])
    assert (code, calls) == (0, 2)
    assert _rows(dest) == 1


def test_persistent_errors_fail_and_leave_no_file(r2):
    # The bug: wrangler leaves an empty file behind, which SQLite opens as an
    # empty DB and the ingest fills from scratch. Nothing may be at dest.
    code, dest, calls = r2(["error"] * 4)
    assert (code, calls) == (1, 4)
    assert not dest.exists()
    assert not Path(str(dest) + ".part").exists()


def test_missing_object_fails_by_default(r2):
    code, dest, calls = r2(["missing"])
    assert (code, calls) == (2, 1)  # not retried: a 404 is an answer
    assert not dest.exists()


def test_missing_object_is_a_fresh_start_when_allowed(r2):
    code, dest, calls = r2(["missing"], allow_missing=True)
    assert (code, calls) == (0, 1)
    assert not dest.exists()


def test_a_truncated_download_is_not_accepted(r2):
    code, dest, calls = r2(["truncated", "ok"])
    assert (code, calls) == (0, 2)
    assert _rows(dest) == 1


def test_a_failed_download_leaves_an_existing_file_alone(r2, tmp_path):
    dest = tmp_path / "data" / "x.db"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"previous")
    code, dest, _ = r2(["error"] * 4, dest=dest)
    assert code == 1
    assert dest.read_bytes() == b"previous"
