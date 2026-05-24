"""
scrape_twitter.py — pull @GeneralStaffUA tweets via Nitter, resolve t.co
links, hand off Facebook URLs to scrape_facebook.

The General Staff's X cross-posts contain ONLY a header line + a t.co URL
pointing at the Facebook share URL — see ./TODO.md and the conversation
that drove this work. We use Nitter (instead of x.com directly) because:

  - No login required → works headlessly in CI without secrets;
  - x.com is heavily JS-rendered and rate-limits anonymous traffic; Nitter
    serves predictable, mostly server-rendered HTML.

Instances rotate / die regularly, so we keep a fallback list + an
in-process circuit breaker (skip an instance after two consecutive
failures within the same run).

CLI usage:
    python scrape_twitter.py list --since 2026-05-20
    python scrape_twitter.py ingest --since 2026-05-20   # fetch + upsert via FB
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from playwright.async_api import async_playwright, Browser, Page, TimeoutError as PWTimeout

import scrape_general_staff as gs
import scrape_facebook as fb

log = logging.getLogger("scrape_twitter")
if not log.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

# Public Nitter mirrors that have been reliable in the recent past. They die
# without warning and new ones appear; users can override this list via
# --nitter-instance (CLI) or by passing nitter_instances= to scrape_profile().
NITTER_INSTANCES = (
    "https://nitter.tiekoetter.com",
    "https://nitter.privacyredirect.com",
    "https://nitter.catsarch.com",
)

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)

# Same threshold the JS reference uses — two timeouts/parsing-failures is
# usually enough to be sure an instance is genuinely down for this run.
INSTANCE_FAILURE_THRESHOLD = 2


@dataclass
class Tweet:
    """One tweet from the timeline, post-pagination."""
    date: datetime              # tz-aware UTC
    text: str                   # body text (Nitter strips the URL shortener)
    links: list[str] = field(default_factory=list)
    # All links found in the tweet body, already resolved past t.co.
    twitter_url: str = ""       # x.com/<handle>/status/<id>


class _InstanceHealth:
    """Per-run circuit breaker for Nitter instances.

    Counts consecutive failures against each base URL; after the threshold
    we skip the instance for the rest of this process. A successful page
    resets the counter. State is process-local, no persistence.
    """

    def __init__(self) -> None:
        self.fails: dict[str, int] = {}

    def record_failure(self, base: str) -> None:
        self.fails[base] = self.fails.get(base, 0) + 1

    def record_success(self, base: str) -> None:
        self.fails[base] = 0

    def live_instances(self, candidates: tuple[str, ...]) -> list[str]:
        """Filter out dead instances; if that empties the list, return the
        full original list (better to retry a dead one than not try at all).
        """
        live = [c for c in candidates if self.fails.get(c, 0) < INSTANCE_FAILURE_THRESHOLD]
        return live or list(candidates)


# Nitter dates look like: "May 23, 2026 · 8:14 AM UTC". The trailing UTC is
# load-bearing — without it strptime treats the time as local.
_DATE_TITLE_RE = re.compile(r"^(?P<date>.+?)\s+·\s+(?P<time>.+?)\s+UTC$")


def _parse_nitter_date(title: str) -> datetime:
    """Parse Nitter's tweet-date title attribute → UTC datetime."""
    m = _DATE_TITLE_RE.match(title.strip())
    if not m:
        raise ValueError(f"Could not parse Nitter date: {title!r}")
    raw = f"{m.group('date')} {m.group('time')}"
    return datetime.strptime(raw, "%b %d, %Y %I:%M %p").replace(tzinfo=timezone.utc)


def _nitter_url_to_twitter(href: str, base: str) -> str:
    """Convert any href Nitter exposes (relative or absolute, possibly pointing
    at the Nitter host) → canonical x.com URL.
    """
    if href.startswith("/"):
        return f"https://x.com{href}".replace("#m", "")
    # Absolute Nitter URL — swap host.
    return re.sub(r"^https?://[^/]+/", "https://x.com/", href).replace("#m", "")


async def _extract_timeline_page(
    page: Page, base: str, username: str
) -> tuple[list[dict], str | None]:
    """Read one Nitter timeline page → (list of raw tweet dicts, next-page URL).

    Each dict has keys: date_title, text, links, twitter_url, is_pinned,
    is_retweet, is_reply. The caller does post-filtering (date cutoff,
    pinned skip, etc).
    """
    raw = await page.evaluate(
        """(username) => {
          const items = [];
          for (const el of document.querySelectorAll('.timeline-item[data-username]')) {
            const dataUsername = el.getAttribute('data-username');
            const tweetLinkEl = el.querySelector('a.tweet-link[href]');
            const dateEl = el.querySelector('.tweet-date a[title]');
            const contentEl = el.querySelector('.tweet-content.media-body');
            // Body text: Nitter renders shortened links as <a> elements with
            // their FULL target URL in the href, while the visible text is the
            // truncated display form. Walk the children, prefer href over text
            // for outbound links.
            let text = '';
            const links = [];
            if (contentEl) {
              for (const node of contentEl.childNodes) {
                if (node.nodeType === 3) {
                  text += node.textContent;
                } else if (node.nodeName === 'BR') {
                  text += '\\n';
                } else if (node instanceof HTMLAnchorElement) {
                  const href = node.href;
                  const hostname = new URL(href).hostname;
                  if (href.startsWith('http') && hostname !== location.hostname) {
                    text += href;
                    links.push(href);
                  } else {
                    text += node.textContent ?? '';
                  }
                } else {
                  text += node.textContent ?? '';
                }
              }
            }
            items.push({
              data_username: dataUsername,
              date_title: dateEl ? dateEl.getAttribute('title') : null,
              text,
              links,
              twitter_url: tweetLinkEl ? tweetLinkEl.getAttribute('href') : null,
              is_pinned: !!el.querySelector('.pinned'),
              is_retweet: !!el.querySelector('.retweet-header'),
              is_reply: !!el.querySelector('.replying-to'),
            });
          }
          const showMoreEl = [...document.querySelectorAll('.show-more a[href]')].at(-1);
          const timelineEnd = document.querySelector('.timeline-end');
          // Nitter's next-page link is often a bare query string like
          // "?cursor=…" — resolve against document.baseURI so we always
          // return an absolute URL the Python caller can navigate to.
          const nextHref = showMoreEl && !timelineEnd
            ? new URL(showMoreEl.getAttribute('href'), document.baseURI).href
            : null;
          return { items, next_href: nextHref };
        }""",
        username,
    )
    next_url = raw["next_href"]
    # If Nitter returned an absolute URL pointing at a different host (some
    # instances rewrite, some don't), force it back to the instance we're
    # talking to so the circuit breaker stays useful.
    if next_url and "://" in next_url:
        parsed_path_query = next_url.split("/", 3)[-1] if next_url.count("/") >= 3 else ""
        next_url = f"{base}/{parsed_path_query}" if parsed_path_query else next_url
    return raw["items"], next_url


async def _try_instance(
    browser: Browser, base: str, username: str
) -> tuple[Page, str] | None:
    """Open the profile page on one Nitter instance. Return (page, start_url)
    on success, None on failure (caller records the failure and retries).
    """
    ctx = await browser.new_context(
        user_agent=DEFAULT_USER_AGENT,
        locale="en-US",
    )
    page = await ctx.new_page()
    start = f"{base}/{username}"
    try:
        await page.goto(start, wait_until="domcontentloaded", timeout=60000)
        # `.timeline`-or-`.profile-card` is Nitter's structural selector. If
        # the instance is up but rate-limited or serving an Anubis PoW
        # interstitial, neither will appear within the timeout and we skip on.
        await page.wait_for_selector(
            ".timeline, .profile-card, .timeline-item", timeout=20000,
        )
    except (PWTimeout, Exception) as e:
        log.warning(f"Nitter instance failed: {base} ({e.__class__.__name__})")
        await ctx.close()
        return None
    return page, start


async def scrape_profile(
    browser: Browser,
    username: str,
    *,
    since: datetime,
    until: datetime | None = None,
    nitter_instances: tuple[str, ...] = NITTER_INSTANCES,
    health: _InstanceHealth | None = None,
):
    """Yield Tweet objects from @username, walking backwards in time until
    the timestamp passes `since`. Pinned tweets and retweets are skipped
    (GS doesn't pin or retweet its own ops reports).

    `since` and `until` are inclusive bounds (tz-aware datetimes).
    """
    if since.tzinfo is None or (until is not None and until.tzinfo is None):
        raise ValueError("since/until must be timezone-aware")
    health = health or _InstanceHealth()
    candidates = health.live_instances(nitter_instances)

    page = None
    base = None
    for cand in candidates:
        result = await _try_instance(browser, cand, username)
        if result is None:
            health.record_failure(cand)
            continue
        page, _ = result
        base = cand
        health.record_success(cand)
        break
    if page is None or base is None:
        raise RuntimeError(
            f"All Nitter instances failed for @{username}: {nitter_instances}"
        )

    try:
        page_num = 0
        next_url: str | None = page.url
        while next_url:
            page_num += 1
            if page_num > 1:
                # Tiny bust to avoid any aggressive caching on subsequent pages.
                bust = f"?_t={int(datetime.now().timestamp() * 1000)}"
                target = next_url + ("&" if "?" in next_url else "?") + bust.lstrip("?")
                await page.goto(target, wait_until="networkidle", timeout=60000)

            items, next_url = await _extract_timeline_page(page, base, username)
            kept_this_page = 0
            reached_cutoff = False
            for raw in items:
                if not raw["date_title"]:
                    continue
                if raw["data_username"].lower() != username.lower():
                    continue
                if raw["is_retweet"] or raw["is_reply"]:
                    continue
                date = _parse_nitter_date(raw["date_title"])
                if raw["is_pinned"]:
                    # Pinned posts can show old dates while sitting at the top
                    # — skip silently; don't let them trip the cutoff.
                    continue
                if date < since:
                    reached_cutoff = True
                    break
                if until is not None and date > until:
                    continue
                kept_this_page += 1
                twitter_url = ""
                if raw["twitter_url"]:
                    twitter_url = _nitter_url_to_twitter(raw["twitter_url"], base)
                yield Tweet(
                    date=date,
                    text=raw["text"].strip(),
                    links=raw["links"],
                    twitter_url=twitter_url,
                )
            log.info(
                f"@{username} page {page_num}: kept {kept_this_page}"
                f"{' [cutoff]' if reached_cutoff else ''}"
            )
            if reached_cutoff:
                break
    finally:
        await page.context.close()


async def resolve_tco(page: Page, url: str) -> str:
    """Follow a t.co redirect once → final URL. Non-t.co URLs are returned
    unchanged. Uses page.context.request so we share cookies/User-Agent with
    the Playwright session.
    """
    if "t.co/" not in url:
        return url
    try:
        # max_redirects=0: capture the Location header from t.co itself
        # rather than the eventual FB page (which may take seconds to load).
        resp = await page.context.request.fetch(url, max_redirects=0)
        loc = resp.headers.get("location")
        if loc:
            return loc
    except Exception as e:
        log.warning(f"t.co resolve failed: {url}: {e}")
    return url


def _looks_like_fb_post_url(url: str) -> bool:
    """Heuristic: does this URL look like a GS Facebook post we can scrape?
    Accepts share/p/, /posts/, /story.php, /videos/ patterns under
    facebook.com. Rejects everything else (twitter image links, etc).
    """
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return False
    if not host.endswith("facebook.com"):
        return False
    path = urlparse(url).path
    return any(
        seg in path
        for seg in ("/share/p/", "/posts/", "/story.php", "/videos/")
    ) or "story.php" in url


async def iter_facebook_urls(
    browser: Browser,
    username: str,
    since: datetime,
    *,
    until: datetime | None = None,
    nitter_instances: tuple[str, ...] = NITTER_INSTANCES,
):
    """Highest-level helper: yield (tweet_date, fb_url) pairs in chronological
    order. Combines `scrape_profile()` with `resolve_tco()` and the FB-URL
    filter. Each tweet emits at most one FB URL (GS posts have one).
    """
    helper_ctx = await browser.new_context(user_agent=DEFAULT_USER_AGENT)
    helper_page = await helper_ctx.new_page()
    try:
        async for tweet in scrape_profile(
            browser, username,
            since=since, until=until,
            nitter_instances=nitter_instances,
        ):
            for link in tweet.links:
                resolved = await resolve_tco(helper_page, link)
                if _looks_like_fb_post_url(resolved):
                    yield tweet.date, resolved
                    break
    finally:
        await helper_ctx.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

async def _cmd_list(args) -> None:
    since = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)
    until = (
        datetime.fromisoformat(args.until).replace(tzinfo=timezone.utc)
        if args.until else None
    )
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            async for tweet_date, fb_url in iter_facebook_urls(
                browser, args.username, since, until=until,
            ):
                print(f"{tweet_date.isoformat()}\t{fb_url}")
        finally:
            await browser.close()


async def _cmd_ingest(args) -> None:
    since = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)
    until = (
        datetime.fromisoformat(args.until).replace(tzinfo=timezone.utc)
        if args.until else None
    )
    conn = gs.open_db(gs.DB_PATH)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            ok = fail = 0
            async for tweet_date, fb_url in iter_facebook_urls(
                browser, args.username, since, until=until,
            ):
                success = await fb.scrape_and_upsert(
                    browser, conn, fb_url, tweet_date,
                )
                if success:
                    ok += 1
                else:
                    fail += 1
                conn.commit()
            log.info(f"Done. Upserted {ok}, failed {fail}.")
        finally:
            await browser.close()
    conn.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--username", default="GeneralStaffUA")
    common.add_argument(
        "--since", required=True,
        help="Only tweets on or after this date (YYYY-MM-DD, UTC).",
    )
    common.add_argument(
        "--until",
        help="Only tweets on or before this date (YYYY-MM-DD, UTC).",
    )

    pl = sub.add_parser(
        "list", parents=[common],
        help="Print resolved FB URLs found in the timeline.",
    )
    pl.set_defaults(handler=_cmd_list)

    pi = sub.add_parser(
        "ingest", parents=[common],
        help="Fetch each FB URL and upsert into the DB via scrape_facebook.",
    )
    pi.set_defaults(handler=_cmd_ingest)

    args = p.parse_args()
    asyncio.run(args.handler(args))


if __name__ == "__main__":
    main()
