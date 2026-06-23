"""
Probe a date window via telethon to see what the channel actually posted,
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

Usage:
  python probe_gap.py --since 2024-10-11 --until 2024-10-16     # date window (MSK)
  python probe_gap.py --dates 2024-10-12 2024-11-21 2025-03-02  # specific MSK dates
  python probe_gap.py --ids 44509 44515 44518                   # specific post_ids
  python probe_gap.py --since 2024-10-11 --until 2024-10-16 --full

`--full` runs parse_report on each post and prints WHY parse rejected it
(AD gate / count regex / breakdown), so we can tell whether a MISSED post
is dropped by the gate, the COUNT_RE noun-phrase anchor, or stored fine.
"""
import argparse
import re
import sqlite3
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

    db_path = Path(args.db)
    if db_path.exists():
        conn = sqlite3.connect(db_path)
        known_ad = {pid for (pid,) in conn.execute("SELECT post_id FROM ad_reports")}
        known_sv = {pid for (pid,) in conn.execute("SELECT post_id FROM summaries")}
    else:
        # No DB → can't mark stored/MISSED, but the gate verdict is still useful.
        print(f"# NOTE: {db_path} not found — every post will be marked MISSED.")
        known_ad, known_sv = set(), set()

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
        def stream():
            for pid, posted, text in ig.iter_telethon(args.channel, offset_date=offset):
                msk_date = posted.astimezone(ig.MSK).date().isoformat()
                if msk_date < min_d:
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
        def stream():
            for pid, posted, text in ig.iter_telethon(args.channel, offset_date=until):
                if posted < since:
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
