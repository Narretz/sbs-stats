#!/usr/bin/env python3
"""
Storage + `weekly` view tests for scripts/zelensky_weekly/ingest.py.

    bash scripts/test_python.sh scripts/zelensky_weekly
"""
from __future__ import annotations

import pathlib
import sys
from datetime import datetime

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import ingest  # noqa: E402
from parse import parse  # noqa: E402

FIXTURES = SCRIPT_DIR / "fixtures"

# 2025-10-26: the morning post (all three), the evening address repeating it
# without bombs, and the English translation of the evening one.
W43 = [
    (16622, "2025-10-26T07:19:42+00:00"),
    (16623, "2025-10-26T16:57:40+00:00"),
    (16624, "2025-10-26T18:40:47+00:00"),
]


def _store(conn, post_id: int, posted: str, text: str | None = None) -> str:
    text = text or (FIXTURES / f"post{post_id}.txt").read_text(encoding="utf-8")
    at = datetime.fromisoformat(posted)
    return ingest.store(conn, post_id, at, text, parse(text, at), "V_Zelenskiy_official")


def test_weekly_view_prefers_the_most_complete_tally(tmp_path):
    conn = ingest._connect(tmp_path / "z.db")
    for post_id, posted in W43:
        assert _store(conn, post_id, posted) == "inserted"
    rows = conn.execute(
        "SELECT period, post_id, drones, bombs, missiles, bombs_bound FROM weekly"
    ).fetchall()
    assert rows == [("2025-W43", 16622, 1200, 1360, 50, "at_least")]


def test_restore_is_unchanged_and_an_edit_is_versioned(tmp_path):
    conn = ingest._connect(tmp_path / "z.db")
    post_id, posted = W43[0]
    assert _store(conn, post_id, posted) == "inserted"
    assert _store(conn, post_id, posted) == "unchanged"

    edited = (FIXTURES / f"post{post_id}.txt").read_text(encoding="utf-8").replace(
        "1360 керованих", "1370 керованих"
    )
    assert _store(conn, post_id, posted, edited) == "updated"
    assert conn.execute("SELECT COUNT(*) FROM reports WHERE post_id = ?", (post_id,)).fetchone() == (2,)
    assert conn.execute("SELECT bombs FROM weekly").fetchone() == (1370,)


def test_partial_week_stays_out_of_the_weekly_view(tmp_path):
    conn = ingest._connect(tmp_path / "z.db")
    _store(conn, 1, "2026-05-13T08:00:00+00:00",
           "За цей тиждень Росія вже застосувала понад 900 ударних дронів і 40 ракет.")
    assert conn.execute("SELECT report_type FROM reports").fetchone() == ("weekly_partial",)
    assert conn.execute("SELECT COUNT(*) FROM weekly").fetchone() == (0,)
