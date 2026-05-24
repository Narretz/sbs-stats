"""
scrape_facebook.py — fetch a single GeneralStaff.ua FB post via Playwright.

No auth required for posts that are still publicly listed (validated against
share/p/ links from today and 3 days ago). The page's body innerText contains
the full operational report — same wording the Telegram cross-post uses —
so the existing parse_summary / parse_directions branches handle it
unchanged.

Why this exists at all: Twitter cross-posts of GS reports only contain the
header line + a t.co URL pointing to the FB share URL. To pull the body
(combat engagements, per-direction breakdown) we have to follow that URL.

CLI usage:
    python scrape_facebook.py https://www.facebook.com/share/p/abc123/ [more URLs ...]

Library usage:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        await scrape_and_upsert(browser, conn, url, tweet_date)
"""
import argparse
import asyncio
import logging
import re
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace

from playwright.async_api import async_playwright, Browser

import scrape_general_staff as gs

log = logging.getLogger("scrape_facebook")
if not log.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

# A fresh share/p/<short>/ load typically redirects to:
#   /story.php?story_fbid=<digits>&id=<digits>&rdid=...
# Both numeric IDs are what we want as the (source_id, page_id) pair.
STORY_RE = re.compile(
    r"[?&]story_fbid=(?P<story>\d+).*?[?&]id=(?P<page>\d+)"
)
# Fallback: /<page_name>/posts/<long_digits>/ — direct post URLs without
# the share redirect. We only support the GS page so the page_id is fixed.
POSTS_RE = re.compile(r"/posts/(?P<story>\d+)/?")

# The General Staff Facebook page numeric ID (constant). Used as a fallback
# when only a /posts/ URL is given (no page_id in the URL).
GENERAL_STAFF_PAGE_ID = "100069092624537"

# Spoof a real Chrome UA so FB doesn't serve us its anti-bot lite shell.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)

# Trailing UI bits that appear AFTER the GS post body. The post text always
# ends with one of "Биймо ворога…", "Разом переможемо!", "Слава Україні!" etc;
# everything after the first occurrence of these markers is FB UI chrome.
# Listed in priority order — the first match wins.
BODY_END_MARKERS = (
    "\nLog In",
    "\nLog in",
    "\nLike\n",
    "\nShare\n",
    "\nFollow\n",
    "\nReactions:",
    "\nSee more posts",
    "\nView more comments",
    "\nMost relevant",
)


class FbFetchError(Exception):
    """Raised when a Facebook fetch fails — timeout, login-walled, etc."""


class NotAnOperationalReport(FbFetchError):
    """The post loaded fine but isn't a daily operational situation report
    (strike announcement, losses tally, personnel/recruitment news, a different
    command's post, …). Expected and common — not an error."""


async def fetch_facebook_post(
    browser: Browser, url: str, *, timeout_ms: int = 30000
) -> dict:
    """Open one FB URL and extract the GS post text + canonical IDs.

    Returns a dict with keys:
      - source_id: the FB story_fbid as a string
      - page_id:   the FB page id as a string
      - url:       canonical /story.php URL (deterministic, used for storage)
      - text:      operational report body, with FB UI chrome stripped
    Raises FbFetchError on failure.
    """
    ctx = await browser.new_context(
        user_agent=DEFAULT_USER_AGENT,
        locale="en-US",
    )
    page = await ctx.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        # 2.5s settle window — FB's first paint is usually fast but the post
        # content can populate slightly later as React hydrates.
        await page.wait_for_timeout(2500)

        final = page.url
        m = STORY_RE.search(final)
        story_fbid = m.group("story") if m else None
        page_id = m.group("page") if m else None
        if not story_fbid:
            m2 = POSTS_RE.search(final)
            if m2:
                story_fbid = m2.group("story")
                page_id = GENERAL_STAFF_PAGE_ID
        if not story_fbid:
            raise FbFetchError(
                f"Could not extract story_fbid from final URL: {final}"
            )

        body = await page.evaluate("document.body ? document.body.innerText : ''")
        start = body.find("Оперативна інформація")
        if start < 0:
            # FB returned an error/login shell instead of the post — most likely
            # a permanently-deleted or geo-restricted post. (Fresh-link gating
            # has not been observed in practice.)
            preview = " ".join(body.split())[:200]
            raise NotAnOperationalReport(
                f"Body does not contain 'Оперативна інформація' header. "
                f"Preview: {preview!r}"
            )
        text = body[start:]
        for marker in BODY_END_MARKERS:
            idx = text.find(marker)
            if idx > 0:
                text = text[:idx]
                break
        canonical = (
            f"https://www.facebook.com/story.php"
            f"?story_fbid={story_fbid}&id={page_id}"
        )
        return {
            "source_id": story_fbid,
            "page_id": page_id,
            "url": canonical,
            "text": text.strip(),
        }
    finally:
        await ctx.close()


async def scrape_and_upsert(
    browser: Browser,
    conn: sqlite3.Connection,
    url: str,
    message_date: datetime,
) -> bool:
    """Fetch one FB post, run it through the existing parser, upsert.

    `message_date` is the timestamp the post was *published* (timezone-aware).
    We typically take this from the Twitter cross-post date — close enough,
    since FB and Twitter posts go out within minutes of each other.

    Returns True on success, False when the fetch / gate / parse fails.
    """
    try:
        fetched = await fetch_facebook_post(browser, url)
    except NotAnOperationalReport:
        # Expected: the GS/X feed mixes in non-report posts we deliberately skip.
        log.info(f"FB skipped (not an operational report): {url}")
        return False
    except FbFetchError as e:
        log.warning(f"FB fetch error: {url}: {e}")
        return False

    # Build a Telethon-Message-like stand-in so parse_summary can read
    # .id / .date / .text the same way it does for Telegram.
    msg = SimpleNamespace(
        id=fetched["source_id"],
        source="facebook",
        date=message_date,
        text=fetched["text"],
    )
    summary = gs.parse_summary(fetched["text"], msg)
    if summary is None:
        log.warning(f"{url}: parse_summary returned None (gate rejected)")
        return False
    directions = gs.parse_directions(fetched["text"], msg, summary.date)
    gs.upsert_report(conn, summary, directions, fetched["text"], fetched["url"])
    log.info(
        f"FB {fetched['source_id']}: upserted "
        f"(date={summary.date}, combat={summary.combat_engagements}, "
        f"dirs={len(directions)})"
    )
    return True


async def _main(urls: list[str]) -> None:
    conn = gs.open_db(gs.DB_PATH)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            for url in urls:
                await scrape_and_upsert(
                    browser, conn, url, datetime.now(timezone.utc),
                )
        finally:
            await browser.close()
    conn.commit()
    conn.close()


def main():
    p = argparse.ArgumentParser(
        description="Scrape one or more FB GeneralStaff.ua post URLs.",
    )
    p.add_argument(
        "urls", nargs="+",
        help="Facebook share/p/, /posts/, or /story.php URLs.",
    )
    args = p.parse_args()
    asyncio.run(_main(args.urls))


if __name__ == "__main__":
    main()
