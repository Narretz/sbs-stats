"""build_app_db.py: the stripped copy, and `--sql` derived tables on it.

Run through the CLI, as CI does. The GSUA case is the one that matters: the
derived `direction_totals` must count only each post's latest version, exactly
like the live query it replaces (useDatabaseGsua.ts queryDirectionList).
"""
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "build_app_db.py"
GSUA_SQL = ROOT / "scripts" / "gsua" / "app_db.sql"


def _gsua_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript((ROOT / "scripts" / "gsua" / "schema.sql").read_text())
    posts = [
        # (source_id, scraped_at, date, text) — post 1 has an edited version.
        ("1", "2026-09-01T10:00", "2026-09-01", "first version"),
        ("1", "2026-09-01T20:00", "2026-09-01", "edited"),
        ("2", "2026-09-02T10:00", "2026-09-02", "another"),
    ]
    for sid, scraped, date, text in posts:
        conn.execute(
            "INSERT INTO posts (source, source_id, date, message_date, snapshot_at, text, url, scraped_at) "
            "VALUES ('telegram', ?, ?, ?, ?, ?, 'u', ?)",
            (sid, date, date, f"{date}T22:00:00", text, scraped),
        )
    directions = [
        # The superseded version's 100 must not count.
        ("1", "2026-09-01T10:00", "Pokrovsk", 100),
        ("1", "2026-09-01T20:00", "Pokrovsk", 10),
        ("2", "2026-09-02T10:00", "Pokrovsk", 5),
        ("2", "2026-09-02T10:00", "Lyman", 20),
        ("2", "2026-09-02T10:00", "Quiet", 0),  # no attacks at all: not listed
    ]
    for sid, scraped, direction, attacks in directions:
        conn.execute(
            "INSERT INTO directions (source, source_id, scraped_at, direction, attacks) VALUES ('telegram', ?, ?, ?, ?)",
            (sid, scraped, direction, attacks),
        )
    conn.commit()
    conn.close()


def _build(src: Path, dst: Path, *extra: str) -> None:
    subprocess.run(
        [sys.executable, str(SCRIPT), "--in", str(src), "--out", str(dst), "--blank", "posts.text", *extra],
        check=True, capture_output=True,
    )


def test_blanks_the_column_and_leaves_the_source_alone(tmp_path):
    src, dst = tmp_path / "g.db", tmp_path / "g.app.db"
    _gsua_db(src)
    _build(src, dst)
    assert {r[0] for r in sqlite3.connect(dst).execute("SELECT text FROM posts")} == {""}
    assert sqlite3.connect(src).execute("SELECT COUNT(*) FROM posts WHERE text != ''").fetchone()[0] == 3


def test_gsua_direction_totals_count_latest_versions_only(tmp_path):
    src, dst = tmp_path / "g.db", tmp_path / "g.app.db"
    _gsua_db(src)
    _build(src, dst, "--sql", str(GSUA_SQL))
    rows = sqlite3.connect(dst).execute(
        "SELECT direction, total, last_date FROM direction_totals ORDER BY total DESC"
    ).fetchall()
    assert rows == [("Lyman", 20, "2026-09-02"), ("Pokrovsk", 15, "2026-09-02")]
    # Derived for the app copy only.
    tables = {r[0] for r in sqlite3.connect(src).execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "direction_totals" not in tables


def test_without_sql_there_is_no_derived_table(tmp_path):
    # The frontend falls back to the live query on such a copy.
    src, dst = tmp_path / "g.db", tmp_path / "g.app.db"
    _gsua_db(src)
    _build(src, dst)
    tables = {r[0] for r in sqlite3.connect(dst).execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "direction_totals" not in tables
