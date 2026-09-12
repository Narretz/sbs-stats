"""
Storage + reparse tests for scripts/sbu_alfa/ingest.py.

The interesting behaviour here isn't the parsing (test_parse.py covers that) —
it's the append-on-change storage model and the `--reparse` path that re-reads
stored text after a parser fix. Each test reproduces the real August 2026
sequence: a recap ingested by a parser that missed two counter lines, then
re-parsed once the patterns were widened.

Run with: pytest scripts/sbu_alfa/test_ingest.py -q
"""
from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

import ingest as ig
import parse as p

FIXTURES = Path(__file__).resolve().parent / "fixtures"
AUGUST = "https://ssu.gov.ua/novyny/alfa-sbu-top1-…-shostyi-misiats-pospil"


def _warnings(caplog) -> str:
    """The WARNING-level findings this run emitted — the same records that
    become GitHub annotations in CI (see scripts/ingest_log.py)."""
    return "\n".join(
        r.message for r in caplog.records if r.levelno >= logging.WARNING
    )


@pytest.fixture
def august_html() -> bytes:
    path = FIXTURES / "august.html"
    if not path.exists():
        pytest.skip(f"fixture {path.name} is not in the repo")
    return path.read_bytes()


@pytest.fixture
def old_parser(monkeypatch):
    """The parser as it was before the fix: blind to `comms` and `ifvs`, which
    is exactly how August 2026 landed in the live DB with 14 of its 16
    counters."""
    monkeypatch.setattr(
        p, "CATEGORIES", [c for c in p.CATEGORIES if c[0] not in ("comms", "ifvs")]
    )


def _store(db: Path, html: bytes, url: str = AUGUST) -> str:
    body = p.extract_text(html.decode("utf-8", "replace"))
    report = p.parse(body)
    return ig.store(db, url, html, report, "title", "2026-09-12")


def _latest_counters(db: Path) -> dict[str, int]:
    conn = sqlite3.connect(db)
    try:
        return dict(conn.execute(
            "SELECT category, value FROM counters_latest"
        ).fetchall())
    finally:
        conn.close()


def _versions(db: Path) -> int:
    conn = sqlite3.connect(db)
    try:
        return conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    finally:
        conn.close()


def test_store_then_reparse_recovers_the_missed_counters(
    tmp_path, august_html, old_parser, monkeypatch, capsys
):
    db = tmp_path / "sbu-alfa.db"
    assert _store(db, august_html) == "inserted"
    assert "comms" not in _latest_counters(db)
    assert "ifvs" not in _latest_counters(db)

    # The parser fix lands…
    monkeypatch.undo()

    # …a dry run reports the diff and writes nothing.
    assert ig.run_reparse(db, apply=False) == 0
    out = capsys.readouterr().out
    assert "would update" in out
    assert "+ comms = 2791" in out and "+ ifvs = 33" in out
    assert _versions(db) == 1
    assert "comms" not in _latest_counters(db)

    # …and --apply appends a new version carrying them.
    assert ig.run_reparse(db, apply=True) == 0
    assert _versions(db) == 2
    got = _latest_counters(db)
    assert got["comms"] == 2791 and got["ifvs"] == 33
    assert len(got) == 16


def test_reparse_is_idempotent(tmp_path, august_html, capsys):
    """A second reparse against the current parser must not append a version —
    the workflow runs `--apply` on demand and an unchanged re-run has to leave
    R2 (and the CDN cache) alone."""
    db = tmp_path / "sbu-alfa.db"
    _store(db, august_html)
    assert ig.run_reparse(db, apply=True) == 0
    assert _versions(db) == 1
    assert "unchanged" in capsys.readouterr().out


def test_reparse_emits_changed_for_the_workflow(tmp_path, august_html, old_parser,
                                                monkeypatch):
    """`changed=` drives the upload step. True only when a row was actually
    written: never on a dry run, never on a no-op apply."""
    db = tmp_path / "sbu-alfa.db"
    _store(db, august_html)
    monkeypatch.undo()

    gh_out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh_out))

    ig.run_reparse(db, apply=False)          # dry run over a changed row
    ig.run_reparse(db, apply=True)           # writes
    ig.run_reparse(db, apply=True)           # nothing left to write
    assert gh_out.read_text().split() == ["changed=false", "changed=true", "changed=false"]


def test_reparse_leaves_a_manual_override_untouched(tmp_path, august_html, caplog):
    """A row stored with a manual --report-type the parser can't reproduce is
    reported and skipped, not silently rewritten to whatever parse() says."""
    db = tmp_path / "sbu-alfa.db"
    body = p.extract_text(august_html.decode("utf-8", "replace"))
    ig.store(db, AUGUST, august_html, p.parse(body), "title", "2026-09-12",
             report_type_override="themed")

    with caplog.at_level(logging.WARNING):
        assert ig.run_reparse(db, apply=True) == 0
    assert _versions(db) == 1
    assert "left untouched" in _warnings(caplog)


def test_reparse_on_a_missing_db_fails_loudly(tmp_path, caplog):
    with caplog.at_level(logging.ERROR):
        assert ig.run_reparse(tmp_path / "nope.db", apply=True) == 1
    assert "does not exist" in caplog.text


def test_warn_unmatched_names_the_unclaimed_line(august_html, old_parser, caplog):
    """The drift finding CI annotates — one WARNING naming both dropped lines,
    raised from ingest so discover.py and the CLI report it identically."""
    report = p.parse(p.extract_text(august_html.decode("utf-8", "replace")))
    with caplog.at_level(logging.WARNING):
        ig.warn_unmatched(AUGUST, report)
    msg = _warnings(caplog)
    assert "2 counter line(s) matched no category" in msg
    assert "вузол" in msg and "бойові броньовані машини" in msg


def test_warn_unmatched_is_silent_when_everything_matched(august_html, caplog):
    report = p.parse(p.extract_text(august_html.decode("utf-8", "replace")))
    assert report.unmatched == []
    with caplog.at_level(logging.WARNING):
        ig.warn_unmatched(AUGUST, report)
    assert _warnings(caplog) == ""
