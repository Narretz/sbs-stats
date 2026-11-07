"""
Telegram-path tests for scripts/sbu_alfa/telegram.py: reading the t.me/s
preview page, dating a post's recap, the gate that keeps every other post out,
and storage under the post's URL.

fixtures/telegram-19024.html is the preview page around the October 2026
recap (https://t.me/s/SBUkr/19024): the recap and seven ordinary posts.

Run with: pytest scripts/sbu_alfa/test_telegram.py -q
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

import parse as p
import telegram as tg
from test_parse import OCTOBER_EXPECTED

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RECAP_ID = 19024


@pytest.fixture(scope="module")
def page_posts():
    return tg.posts_on_page((FIXTURES / "telegram-19024.html").read_text(encoding="utf-8"))[0]


def _recap(page_posts):
    return next(post for post in page_posts if post[0] == RECAP_ID)


def test_preview_page_yields_dated_posts(page_posts):
    assert len(page_posts) == 8
    pid, posted_at, text = _recap(page_posts)
    assert posted_at == datetime(2026, 11, 7, 10, 0, 11, tzinfo=timezone.utc)
    assert tg.title_of(text).startswith("Вісім місяців лідерства «Альфи» СБУ")


def test_the_recap_post_parses_like_the_article(page_posts):
    _, posted_at, text = _recap(page_posts)
    report = p.parse(p.extract_text(text), tg.kyiv_date(posted_at))
    assert report.period == "2026-10"
    assert {c.category: (c.value, c.bound) for c in report.counters} == OCTOBER_EXPECTED
    assert report.unmatched == []


def test_only_the_recap_passes_the_gate(page_posts):
    passed = [
        pid for pid, posted_at, text in page_posts
        if p.is_monthly_recap(p.parse(p.extract_text(text), tg.kyiv_date(posted_at)))
    ]
    assert passed == [RECAP_ID]


@pytest.mark.parametrize("month, published_at, period", [
    ("березні", "2026-04-17", "2026-03"),   # the March recap's post: no year in its text
    ("грудні", "2027-01-09", "2026-12"),    # December's, posted in January
    ("жовтні", "2026-10-31", "2026-10"),    # posted before the month is out
])
def test_a_yearless_post_is_dated_by_its_posting(month, published_at, period):
    assert p.parse(f"У {month} спецпризначенці знешкодили понад 100 окупантів", published_at).period == period


def test_a_year_in_the_text_wins_over_the_posting_date():
    assert p.parse("за підсумками березня 2025 року", "2026-04-17").period == "2025-03"


def test_store_post_keys_the_recap_by_its_url_and_skips_the_rest(page_posts, tmp_path):
    out = tmp_path / "sbu-alfa.db"
    statuses = {pid: tg.store_post(out, pid, dt, text, dry_run=False) for pid, dt, text in page_posts}
    assert statuses[RECAP_ID] == "inserted"
    assert set(statuses.values()) == {"inserted", "not-a-recap"}
    conn = sqlite3.connect(out)
    rows = conn.execute("SELECT url, period, published_at, report_type FROM reports").fetchall()
    conn.close()
    assert rows == [("https://t.me/SBUkr/19024", "2026-10", "2026-11-07", "monthly_top1")]
    assert tg.newest_stored_post(out) == RECAP_ID
    # Stored again unchanged, nothing new is written.
    _, dt, text = _recap(page_posts)
    assert tg.store_post(out, RECAP_ID, dt, text, dry_run=False) == "unchanged"


def test_newest_stored_post_ignores_article_rows(tmp_path):
    assert tg.newest_stored_post(tmp_path / "missing.db") == 0
    out = tmp_path / "sbu-alfa.db"
    conn = sqlite3.connect(out)
    conn.executescript(tg.ingest.SCHEMA)
    conn.execute(
        "INSERT INTO reports (url, scraped_at, report_type, body_text, body_html_hash) "
        "VALUES ('https://ssu.gov.ua/novyny/alfa-sbu-top1', 'x', 'monthly_top1', '', '')"
    )
    conn.commit()
    conn.close()
    assert tg.newest_stored_post(out) == 0


def test_the_walk_stops_at_the_newest_stored_post(page_posts, monkeypatch):
    html = (FIXTURES / "telegram-19024.html").read_text(encoding="utf-8")
    fetched: list[str] = []
    monkeypatch.setattr(tg, "_fetch", lambda url: fetched.append(url) or html)
    ids = [pid for pid, _, _ in tg.iter_channel(since_id=19020, max_pages=5, sleep=0)]
    assert ids and all(pid > 19020 for pid in ids)
    assert len(fetched) == 1
