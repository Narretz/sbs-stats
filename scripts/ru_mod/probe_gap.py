"""
Probe a date window against the channel to see what it actually posted,
independent of the AD/svodka gates. Used to investigate suspected gap days:
the regular ingest only stores posts that pass a gate, so a day with no
ad_reports row could mean "MoD didn't post one" OR "gate rejected it" — this
script tells the two apart by listing every post in the window with its gate
verdict and whether we've already stored it.

Output line: <post_id> <posted MSK date+time> <gate> <stored?>  <text snippet>
  gate    = AD (passes AD gate) | SV (passes svodka gate) | --  (neither)
  stored  = stored (in ad_reports or summaries) | MISSED (we don't have it)

Lines worth inspecting:
  '-- MISSED'   — channel posted something we don't store; if the snippet
                  mentions БПЛА/ПВО, it's an AD-gate miss to fix.
  'AD MISSED'   — would pass the gate but never reached our scraper (need to
                  re-run `ingest.py --source telethon --since … --until …`).

Two backends, same output. `--source web` (the DEFAULT) reads the public
t.me/s preview with the stdlib, exactly as the scheduled ingest does, and needs
no Telegram account — which is what makes this usable from CI or an agent
sandbox. It can only walk backwards from the channel head, so it is the right
tool for a RECENT gap (a few pages) and the wrong one for 2024 (hundreds). When
the walk runs out of pages before reaching the window, that is reported loudly:
"no posts" must never be mistaken for "the MoD was silent".

`--source telethon` uses the Telegram API (needs TELEGRAM_API_ID/HASH) and can
start at an arbitrary date, so it stays the tool for historical windows. `--ids`
is telethon-only: fetching by id is one API call, whereas the web preview would
have to page back through tens of thousands of posts to reach a 2024 id.

Usage:
  python probe_gap.py --since 2026-09-20 --until 2026-09-22     # date window (MSK)
  python probe_gap.py --dates 2026-09-21 2026-09-22             # specific MSK dates
  python probe_gap.py --since 2024-10-11 --until 2024-10-16 --source telethon
  python probe_gap.py --ids 44509 44515 44518                   # telethon only
  python probe_gap.py --since 2026-09-20 --until 2026-09-22 --full

`--full` runs parse_report on each post and prints WHY parse rejected it
(AD gate / count regex / breakdown), so we can tell whether a MISSED post
is dropped by the gate, the COUNT_RE noun-phrase anchor, or stored fine.
"""
import argparse
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import ingest as ig


def _diagnose(text: str) -> str:
    """Walk parse_report's checks in order, return the first failure label
    (or 'OK <drones>') so we can see why a post we expected to ingest is
    being silently dropped."""
    import re, html
    flat = re.sub(r"\s+", " ", ig._strip_md(html.unescape(text))).strip()
    if not ig.AD_GATE.search(flat):
        return "drop: AD_GATE"
    if "беспилотн" not in flat.lower():
        return "drop: no 'беспилотн' token"
    drones = ig._extract_drones(flat)
    if drones is None:
        return "drop: no headline count matched (verb-first/noun-first/singular)"
    bd = ig.parse_breakdown(flat)
    return f"OK drones={drones} bd={len(bd)}"


_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _check_date(date_str: str, flag: str) -> str:
    if not _DATE_RE.fullmatch(date_str):
        raise argparse.ArgumentTypeError(f"{flag} must be YYYY-MM-DD, got {date_str!r}")
    return date_str


# How far back the caller asked us to look, and whether we got there. The web
# backend walks from the channel head, so "0 posts in the window" has two very
# different causes — the channel really posted nothing, or we ran out of pages
# before reaching the dates. Conflating those would turn this tool into a
# machine for wrongly concluding the MoD was silent, which is the single thing
# it exists to prevent.
class _Reach:
    def __init__(self):
        self.crossed = False   # saw a post OLDER than the lower bound

    def note_older(self):
        self.crossed = True


def _web_stream(args, lower_bound_msk: str, keep, reach: "_Reach"):
    """Walk the t.me/s preview newest→oldest, yielding posts `keep` accepts.

    `backfill=True` / `since_id=0` because a probe wants every post regardless
    of what is already stored — the stored/MISSED flag is computed downstream.
    """
    for pid, posted, text in ig.iter_web(
        args.channel, since_id=0, max_pages=args.max_pages,
        sleep=args.sleep, backfill=True,
    ):
        msk_date = posted.astimezone(ig.MSK).date().isoformat()
        if msk_date < lower_bound_msk:
            reach.note_older()
            return
        if keep(msk_date):
            yield pid, posted, text


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument("--since", help="Lower bound (inclusive), YYYY-MM-DD MSK.",
                   type=lambda s: _check_date(s, "--since"))
    p.add_argument("--until", help="Upper bound (inclusive), YYYY-MM-DD MSK. "
                                   "telethon walks newest→oldest from here.",
                   type=lambda s: _check_date(s, "--until"))
    p.add_argument("--dates", nargs="+", metavar="YYYY-MM-DD",
                   type=lambda s: _check_date(s, "--dates"),
                   help="Specific MSK dates to probe (any number, not necessarily "
                        "contiguous). Cheaper than a wide --since/--until when you "
                        "only care about a few suspect days.")
    p.add_argument("--ids", type=int, nargs="+",
                   help="Specific post_ids to fetch instead of dates.")
    p.add_argument("--full", action="store_true",
                   help="Print the post's full text + parse_report verdict.")
    p.add_argument("--source", choices=("web", "telethon"), default="web",
                   help="Backend. web (default) reads the t.me/s preview with no "
                        "Telegram account but can only walk back from the channel "
                        "head; telethon can start at any date.")
    p.add_argument("--max-pages", type=int, default=40,
                   help="web: pages to walk before giving up (10-20 posts each). "
                        "A recent gap needs a handful; a 2024 one is out of reach "
                        "— use --source telethon.")
    p.add_argument("--sleep", type=float, default=1.0,
                   help="web: delay between page fetches.")
    p.add_argument("--channel", default="mod_russia")
    p.add_argument("--db", default=str(Path(__file__).parent.parent.parent
                                       / "data" / ig.DEFAULT_DB_NAME),
                   help="Path to ru-mod-ad.db (just for the stored/MISSED flag).")
    p.add_argument("--snippet", type=int, default=140,
                   help="Chars of the post text to print (ignored with --full).")
    args = p.parse_args()

    selectors = [bool(args.ids), bool(args.dates), bool(args.since or args.until)]
    if sum(selectors) != 1:
        p.error("provide exactly one of: --ids <id> [<id> ...], --dates <date> [<date> ...], "
                "or --since YYYY-MM-DD --until YYYY-MM-DD")
    if args.since and not args.until or args.until and not args.since:
        p.error("--since and --until must be used together (use --dates for non-contiguous days)")
    if args.ids and args.source != "telethon":
        p.error("--ids needs --source telethon: fetching by id is one API call, "
                "while the web preview would have to page back through tens of "
                "thousands of posts to reach an arbitrary id")

    db_path = Path(args.db)
    if db_path.exists():
        conn = sqlite3.connect(db_path)
        known_ad = {pid for (pid,) in conn.execute("SELECT post_id FROM ad_reports")}
        known_sv = {pid for (pid,) in conn.execute("SELECT post_id FROM summaries")}
    else:
        # No DB → can't mark stored/MISSED, but the gate verdict is still useful.
        print(f"# NOTE: {db_path} not found — every post will be marked MISSED.")
        known_ad, known_sv = set(), set()

    reach = _Reach()

    # Pick the post stream: either every post in a date range, or just the
    # specific ids requested (used to drill into known-suspicious posts).
    if args.ids:
        # Direct fetch-by-id — telethon's get_messages(ids=[…]) returns the
        # listed messages in a single API call. (iter_messages can only walk
        # the timeline newest→oldest, which would mean iterating through
        # tens of thousands of posts to reach a 2024 id.)
        import os
        from telethon import TelegramClient
        from telethon.tl.types import Message
        api_id = os.environ["TELEGRAM_API_ID"]
        api_hash = os.environ["TELEGRAM_API_HASH"]
        session = os.environ.get("RU_MOD_SESSION", "ru_mod_session")
        def stream():
            with TelegramClient(session, int(api_id), api_hash) as client:
                # iter_messages(ids=…) is the sync iterator form (same shape
                # iter_telethon uses); get_messages(ids=…) returns a coroutine.
                for m in client.iter_messages(args.channel, ids=args.ids):
                    if isinstance(m, Message) and m.text:
                        yield m.id, m.date.astimezone(timezone.utc), m.text
        src = stream()
    elif args.dates:
        # Multi-date probe: walk newest→oldest from one day past the
        # latest wanted date, emit posts whose MSK date is in the set,
        # stop once we've slipped past the earliest wanted date.
        wanted = set(args.dates)
        min_d = min(args.dates)
        max_d = max(args.dates)
        offset = datetime.fromisoformat(f"{max_d}T23:59:59+03:00")
        if args.source == "web":
            src = _web_stream(args, min_d, lambda d: d in wanted, reach)
        else:
            def stream():
                for pid, posted, text in ig.iter_telethon(args.channel, offset_date=offset):
                    msk_date = posted.astimezone(ig.MSK).date().isoformat()
                    if msk_date < min_d:
                        reach.note_older()
                        return
                    if msk_date in wanted:
                        yield pid, posted, text
            src = stream()
    else:
        # --since/--until window — interpret as inclusive MSK dates,
        # converted to the corresponding UTC instants so a post posted
        # at 23:30 MSK on --until still falls inside.
        since = datetime.fromisoformat(f"{args.since}T00:00:00+03:00")
        until = datetime.fromisoformat(f"{args.until}T23:59:59+03:00")
        if args.source == "web":
            src = _web_stream(
                args, args.since, lambda d: args.since <= d <= args.until, reach
            )
        else:
            def stream():
                for pid, posted, text in ig.iter_telethon(args.channel, offset_date=until):
                    if posted < since:
                        reach.note_older()
                        return
                    yield pid, posted, text
            src = stream()

    n_total = n_ad = n_sv = n_missed = 0
    for pid, posted, text in src:
        n_total += 1
        flat = ig._strip_md(text)
        ad = bool(ig.AD_GATE.search(flat)) and "беспилотн" in flat.lower()
        sv = bool(ig.SVODKA_GATE.search(flat))
        gate = "AD" if ad else ("SV" if sv else "--")
        # Distinguish stored-AS-AD from stored-AS-SV — the AD gate fires on
        # many Сводка posts because they recap "перехвачено и уничтожено N
        # БПЛА" stats, but parse_summary takes them first in main() so the
        # row ends up in `summaries`, not `ad_reports`. A flat "stored" was
        # misleading there.
        if pid in known_ad:
            flag = "as-AD "
        elif pid in known_sv:
            flag = "as-SV "
        else:
            flag = "MISSED"
            n_missed += 1
        if ad:
            n_ad += 1
        if sv:
            n_sv += 1
        if args.full:
            verdict = _diagnose(text)
            full = " ".join(flat.split())
            print(f"━━━ {pid} {posted:%Y-%m-%d %H:%M} {gate} {flag} — {verdict}")
            print(f"    {full}\n")
        else:
            snippet = " ".join(flat.split())[: args.snippet]
            print(f"{pid:>6} {posted:%Y-%m-%d %H:%M} {gate} {flag:>6}  {snippet}")

    if args.ids:
        where = f"ids {args.ids}"
    elif args.dates:
        where = f"dates {sorted(args.dates)}"
    else:
        where = f"[{args.since}, {args.until}] MSK"
    print(
        f"\n# {n_total} post(s) in {where}:"
        f" {n_ad} AD-gate, {n_sv} svodka-gate, {n_missed} not in our DB."
    )
    # The web walk never got past the oldest date asked for, so the window was
    # only partly covered — or not at all. Saying "0 posts" here without saying
    # this would read as "the channel was silent", which is the wrong
    # conclusion and the expensive one: it is what `--mark-silent` records.
    if args.source == "web" and not args.ids and not reach.crossed:
        print(
            f"# INCOMPLETE: walked {args.max_pages} page(s) of the t.me/s preview "
            f"without reaching a post older than {where} — the window is not "
            f"fully covered, so absence here does NOT mean the channel was "
            f"silent. Raise --max-pages, or use --source telethon for an older "
            f"window."
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
