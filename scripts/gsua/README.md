# GSUA scrapers — Ukrainian General Staff operational reports

Scrapes the Ukrainian **General Staff** daily operational reports (combat
engagements, air/missile/KAB/drone strikes, artillery, and per-direction attack
counts) into the SQLite schema in `schema.sql` — the same DB the **RU ATTACKS —
GSUA** view of the app reads.

The General Staff publishes the **identical wording** across several channels, so
there are multiple source paths to the same report text. All feed one shared
parser and one `upsert_report`, so rows are identical regardless of source;
`source` is recorded per row.

| Path | File | Auth | CI? | Status |
|---|---|---|---|---|
| **Telegram web preview** (`t.me/s/GeneralStaffZSU`) | `scrape_general_staff.py --source web` | none (plain HTTP) | yes | **primary CI source** |
| **Telegram API** (`@GeneralStaffZSU`) | `scrape_general_staff.py --source telethon` | API id/hash + interactive phone login on first run | no (see caveats) | best for backfill |
| **Nitter → Facebook** | `scrape_twitter.py` → `scrape_facebook.py` | none | yes | legacy fallback (to be removed) |

## Files

- **`scrape_general_staff.py`** — the core. Holds **all shared logic**: the
  report detector (gate), the regex parsers (`parse_summary` /
  `parse_directions`), dataclasses (`DailySummary`, `DirectionEntry`), the DB
  layer (`open_db`, `upsert_report`), and one-shot schema migrations. The other
  scrapers `import scrape_general_staff as gs` and reuse it. Two source backends:
  - `--source web` (default) — parses the public `t.me/s/<channel>` HTML preview
    via `iter_web_preview` (stdlib only, no login, no browser). The preview
    returns the **full** report text (no truncation). Resumes from the highest
    stored Telegram `source_id` unless `--since`/`--backfill` is given.
  - `--source telethon` — Telethon client for the Telegram API. Needs
    `TELEGRAM_API_ID` + `TELEGRAM_API_HASH`; first run prompts a phone login and
    writes `gs_scraper_session.session`. Richest source for manual backfills.
  - Window: `--since YYYY-MM-DD` / `--until YYYY-MM-DD` for explicit re-scrapes.
- **`scrape_twitter.py`** / **`scrape_facebook.py`** — legacy Nitter→Facebook
  fallback (reads `@GeneralStaffUA` on X, resolves the `t.co`→Facebook share URL,
  Playwright-fetches the FB post body). Kept until the web-preview path is proven
  out; slated for removal.
- **`check_db.py`** — whole-table data-quality checks, the ones `_sanity_check`
  can't do because it sees one post at a time (currently: dates where exactly
  one of `missile_strikes` / `missiles_used` is set). Run after a scrape with
  `--since`; findings go through the shared diagnostics sink.
- **`reparse.py`** — re-parses rows already in the DB **without** hitting any
  source, for after a parser change. Selectors: message ids, `--source`,
  `--null-combat`, `--since/--until`, `--all`, `--dry-run`. Rows that no longer
  pass the gate are deleted.
- **`run_local.sh`** — runs the whole pipeline locally (download DB from R2 →
  scrape → upload to R2). Steps are independently skippable
  (`--no-download` / `--no-scrape` / `--no-upload`).
- **`test_scrape_general_staff.py`** — pytest suite locking in every wording
  variant. Run with `pytest -q`.
- **`schema.sql`** — the canonical target DB shape, loaded by `open_db` at
  import. Idempotent; includes the covering indices the app's queries rely on.

## DB output

Writes **`output/ru-attacks-gsua.db`** (override with `GSUA_DB_NAME`). CI
downloads/uploads the R2 object of the same name.

## Schema & edit-versioning

Tables `posts` + `directions`, view `daily_combined`. The schema is
**append-only / edit-versioned**: a Telegram post can be edited after we first
store it, so `scraped_at` (ingest time) is part of the primary key —
`PRIMARY KEY (source, source_id, scraped_at)`. An edit inserts a **new version
row** rather than overwriting; no version is ever lost. Every read resolves the
latest `scraped_at` per `(source, source_id)` (the `daily_combined` view does
this via `NOT EXISTS`). `scraped_at` was already a populated column pre-versioning,
so historical rows keep their original value — no NULLs, no backfill.

Two distinct timestamps, don't confuse them:
- **`snapshot_at`** — the report's *own* header time (`станом на HH:MM DD.MM.YYYY`,
  Kyiv local, naive). What the report is about.
- **`scraped_at`** — when *we* ingested it. The version key.

The `date` column is the day the report **covers**, not the day it was posted
(the 08:00 morning wrap-up is shifted back one day).

## What the channel publishes

Three slots per day, all Kyiv local time:

| slot | role | day-of-coverage |
| --- | --- | --- |
| 08:00 | morning wrap-up | covers the **previous** day |
| 16:00 | midday update | covers the same day, 00:00→now |
| 22:00 | evening report | covers the same day |

Header is always `Оперативна інформація станом на HH:MM DD.MM.YYYY щодо
російського вторгнення` (older posts use the Ukrainian-month form "9 травня 2026").

**GSUA only reports enemy actions.** "агресор N разів атакував" / "окупанти
атакували N разів" / "ворог N разів атакував" / "N бойових зіткнень" /
"кількість X становить N" are all the **same** metric, just phrased differently —
don't add a separate "attacks" column for midday posts.

## Parser structure (`combat_engagements`)

Branches tried in order, first match wins:

| # | branch | example |
| - | --- | --- |
| 1a | digit, separated form | "138 бойових зіткнень" |
| 1b | digit, compound form, line-anchored | "Загалом… зафіксовано 201 боєзіткнення" |
| 1c | word form, line-anchored | "відбулося сто бойових зіткнень" |
| 2 | midday "(агресор\|ворог) N разів атакував" | "ворог 95 разів атакував позиції Сил оборони" |
| 3 | midday "окупанти атакували N разів" | "окупанти атакували 75 разів" |
| 4 | midday "кількість X (становить\|складає) N" | "кількість атак агресора вже становить 64" |

Branches 1b/1c/2 are **anchored** to disambiguate from per-direction text that
reuses similar phrasing. **Directions** are detected via the `direction_pattern`
regex (any "На X[ому/ій/их/ім] [та/і/й Y] напрямк…" phrase; paired headers emit
both) and normalised through the hardcoded `DIRECTION_NAMES` table; unmatched
ones fall to a Title-case fallback and get a `_sanity_check` warning.

## Recurring channel quirks

- **Wording drifts** every few months — each variant is locked in by a test.
- **Header typos at month/year boundaries** (e.g. `11.12.2025` written on Dec 1).
  Auto-detected by comparing header date to the message's Kyiv-local date with a
  **12-hour** distance threshold (not a calendar-day check — late posts cross
  midnight); corrected `snapshot_at` + a `notes` marker record what happened.
- **Per-direction "mini-aggregates"** reuse global aggregate wording inside
  direction sections; the real global is distinguished by **line position**
  (always at paragraph start, never mid-sentence after "На X напрямках").
- **Apostrophe variants** (U+02BC ʼ, U+2019 ', ASCII ') and **en-dash in
  direction names** (U+2013) are normalised before lookup.
- **Paired anchors share one total** ("На X і Y напрямках відбулося 15
  боєзіткнень" = 15 across both, hence `attacks_group_size` and fair-share) —
  *except* when the sentence ends in **`відповідно`**, which states one figure
  per direction in name order ("…зросла до 13 і восьми відповідно"). Those get
  their own values at `group_size = 1`. One instance in the corpus so far
  (msg 15376), and reading it as a shared total charted 6.5 and 6.5.
- **Word-form direction counts move around the sentence** while digit counts
  don't: the digit branch is position-free, but every word-form branch is
  anchored to a verb or noun on one side of the number. So "атакував двічі",
  "намагався покращити свої позиції один раз" and "одну марну спробу" all read
  as NULL until a position-free word branch (gated on the sentence being about
  assaults) and a futility-adjective branch were added (2026-09).
- **Unnumbered singular assaults** ("здійснив атаку у бік Х", "зупинили спробу
  просунутися") are counted as **1**. It's a floor — the report gives no
  number — but far closer than NULL, which is reserved for "no activity" and
  for paragraphs that report only strikes/shelling and no assault at all.

## Working loop: scrape backwards a month at a time

```sh
python scrape_general_staff.py --source web --since 2025-09-01 --until 2025-09-30
```

Read the WARN lines — they surface NULL `combat_engagements` (usually a new
wording variant), impossible values (`combat_engagements < max(direction.attacks)`),
auto-corrected header typos, unmapped directions, "unusual direction count"
(<~5 directions; usually a legitimate short midday update, sometimes a real
parser miss), and **"possible direction-count gap"** — a paragraph that reports
an assault and contains a number no branch could read. That last one is the
coverage check: every other warning here fires on a value that looks wrong,
which is why the word-form direction counts stayed broken from 2024 to 2026
(a quiet sector storing NULL looked like nothing at all).

The aggregate metrics get the same treatment from **"aggregate metric not
parsed"**, which fires when a report is missing one of the numbers its report
type normally carries. The expectation is per report type, in
`_EXPECTED_METRICS` — the 08:00 wrap-up carries air strikes, KABs, kamikaze
drones, shellings and UA targets hit; the 22:00 one carries all of those but
targets hit; the (discontinued) 16:00 interim report carries only the
engagement count, so it's exempt rather than warning ~570 times about archived
reports that are correct. A snapshot hour that isn't in the table emits a
*notice* instead of silently skipping the check, so a schedule change can't
switch it off unnoticed. At ~2% of reports it's a panel worth reading; if a
wording change pushes that up, fix the regex rather than widening the exempt
list. For each new variant: add a regex branch / stop-word /
`DIRECTION_NAMES` entry, add a **regression test** keyed to the msg_id, commit,
then re-parse in place (no re-scrape):

```sh
python reparse.py --null-combat   # or: python reparse.py 28902 28942
pytest -q
```

That fixes the local DB only. To land the same fix in R2, dispatch the
**`reparse-gsua-db.yml`** workflow (`since` = a date or `all`; `dry_run` is
on by default — run it once to read the diff in the job summary, then again
unchecked to write). It reparses the DB pulled from R2 and re-uploads both
the full DB and the frontend's `.app.db` copy. Widening the scrape lookback
does **not** do this: a re-scrape re-ingests identical text.

When triaging many "unusual direction count" warnings, dispatch an `Explore`
subagent — the per-msg work is read-only (compare bold headers against the
`directions` table) and parallelises well. Tell it to bucket each as
(a) legitimate short report, (b) real parser miss (name the new wording), or
(c) other, and to **verify against the `directions` table**, not the prose alone.

### Don't repeat these mistakes

- Don't add a word-form aggregate fallback without anchoring it to a day-marker
  at line start — per-direction "відбили п'ять боєзіткнень" lines will eat it.
- Don't add `ворог` to the midday "N разів атакував" pattern without the
  `позиц… Сил оборони` suffix anchor — per-direction lines get picked up instead.
- Don't loosen the gate to "≥2 of 4 patterns" — press statements / commander
  quotes match patterns 2+3 in narrative prose. Pattern 1
  (`Оперативна інформація`) must be required.
- Don't strip only `" "` and `" "` out of a captured number. The GS also
  uses U+202F (narrow no-break space) as a thousands separator, so `int()`
  raised and 113 posts' counts were swallowed as "not found" — including every
  kamikaze-drone figure for weeks at a time. Use `_digits()`, which strips
  `\s` wholesale.
- Don't read a sub-count with a digit-first pattern. `mlrs_shellings` sits
  after the shellings total in the same sentence ("155 обстрілів, шість із
  яких – із реактивних систем"), so nearest-to-the-anchor wins, not
  leftmost-digit; `_parse_mlrs` walks backwards from the anchor for that
  reason. Requiring the "з/із" preposition is what keeps it out of the
  equipment-loss list, where "одну РСЗВ" means one MLRS *destroyed*.
- Don't read an aggregate out of a wrap-up's appended "Від початку цієї доби"
  block — that block is about the day the post was published, not the day the
  report covers. `_prev_day_scope` trims it off.
- Don't widen a pattern to a wording the per-direction paragraphs also use
  without putting `_AGG_LEAD` in front of it. The air-strike contraction
  ("42 авіаудари") is the aggregate's wording *and* every sector paragraph's;
  unanchored it pulled 80 sector counts in as daily totals. The long form
  ("42 авіаційні удари") keeps its unanchored patterns as a fallback, so
  nothing that resolved before resolves differently.
- Don't assume `_AGG_LEAD` sees the whole paragraph. It starts at any `\n`,
  not at a blank line, so a soft-wrapped direction paragraph can begin a match
  past its own "напрямк". Tightening it to a real paragraph break costs 156
  values (plenty of 2024 posts separate paragraphs with a single newline), so
  the leak is accepted: 6 posts archive-wide.
- Don't order two forms of the same count as primary-and-fallback when both
  can appear in one post. The thousands form ("близько чотирьох тисяч
  обстрілів") is the aggregate; the plain form further down is a sector
  figure. Plain-first read the sector figure on 15 posts. They compete by
  POSITION instead — leftmost wins, because the aggregate comes first.
- Don't take the first "уразили" in a post as the UA targets tally. The same
  verb describes RUSSIA hitting a Ukrainian town ("Ще одним КАБом російські
  терористи уразили Старицю") and air defence downing drones ("захисники неба
  уразили 24 «шахеди»" — a different series). Counting the first kind doesn't
  just inflate the figure, it credits the wrong side. `_not_our_strike` rejects
  those three shapes; note that its enemy-subject test allows NO word between
  the noun and the verb, because "…ОВТ противника **і** уразили два мости" is
  ours with "противника" as the previous clause's object.
- Don't let a multiplier word into a count-to-noun gap. `_COUNT_GAP` excludes
  `тисяч`/`сотень`/`сотні` because "майже 1,5 тисячі дронів-камікадзе"
  otherwise matches with the gap holding "тисячі" and the count reading as
  the 5 after the decimal comma — 1500 stored as 5. Blocking it lets the
  phrase fall through to `_scaled_counts`.

## Metric notes

- **`shellings` is not artillery-only.** The GS reports a bare "обстріл"
  count — tube artillery, mortars and MLRS together — and writes "зі
  ствольної артилерії" when it means tube artillery specifically. Only 5
  posts in the archive say "артилерійських обстрілів" as the *daily* total
  wording; 1303 have no weapon qualifier at all.
- **`mlrs_shellings` is a SUBSET of `shellings`, not a sibling.** One
  sentence carries both: "155 обстрілів, шість із яких – із реактивних
  систем". Never sum them. The frontend labels them "RU Shellings (all
  types)" / "RU MLRS Shellings (subset)" for this reason.
- **Round figures are floors.** `_scaled_counts` reads "понад чотири тисячі
  обстрілів" as 4000, "близько півтори тисячі дронів-камікадзе" as 1500,
  "сім сотень" as 700 and a bare "понад тисячу" as 1000 — each understated by
  up to the size of the hedge. The alternative was a ~100-day hole in an
  otherwise daily series for `shellings` and ~150 posts for
  `kamikaze_drones`; the hedge word itself is not recorded, because the GS
  gives no better figure and every value in these series is its own claim.
  An exact count always wins: the scaled reader runs only when no digit form
  matched (`kamikaze_drones`) or when it appears earlier in the post
  (`shellings` — see `_parse_shellings`).

## Multipart posts — a known, bounded gap

**Dead format.** The channel split long reports into `(1/2)` / `(2/2)` between
**2024-05-24 and 2024-11-26** — 171 rows, 116 of them in June 2024 — and has
not done it since. A scan of every stored post for *any* split-looking marker
(round and square brackets, the `(1\2)` backslash typo, `частина N`,
`продовження`) finds 171 hits, all in 2024, **all already flagged**.

**What the parser does.** `parse_summary` returns early on a continuation part
(`part` > 1), leaving every aggregate NULL. Only `parse_summary` — directions
are parsed from continuation parts normally, and that is where most of them
live (541 direction rows from 78 part-2 posts, against 190 from 93 part-1s).

**Why.** Part 2 carries no aggregate paragraph, and every aggregate extractor
takes the leftmost match. Parsing a continuation part on its own yields a
*per-direction* figure where the daily total should be — measured against the
`1/2` sibling, 53 values come out wrong: combat 31, KABs 10, air 7, shellings
4, kamikaze 1, e.g. combat 110 → 10 and shellings 4000 → 472. Every one is
smaller than the true value, so `daily_combined`'s `MAX()` would mask them;
the early return protects the raw `posts` rows, which `reparse`, `check_db`
and ad-hoc queries read directly.

**What it costs.** 29 aggregate values that exist only in part 2 —
targets_destroyed 12, KABs 5, kamikaze 4, MLRS 3, air 2, shellings 2, combat 1.

### If someone wants to close it

Stitching works, and is easier than it looks. Pairing is unambiguous: 74 of
the 78 continuation parts pair on `snapshot_at`, and in **all 74** the
`source_id` delta is exactly 1 (consecutive messages). No snapshot holds more
than two parts. Parsing `part1 + "\n\n" + part2` with the split markers
stripped gains those 29 values and changes only 3 — all `combat_engagements`,
all for the worse (88→10, 89→37, 95→10), branch 1a reaching into part 2.

If no new multipart post will ever arrive, do it in `reparse.py`.
If they do, note that the web preview iterates newest→oldest —
part 2 is processed before part 1, so the sibling isn't in the DB yet.
(The telethon path uses `reverse=True` and would be
fine.) At reparse time both rows exist by definition. Sketch: when a row has
`part` > 1, fetch its sibling by `(source, snapshot_at, part='1/2')`, parse
the join, keep **part 1's `combat_engagements`**, and write the result to both
rows so the `MAX()` merge is unaffected either way.

### Related defect: the halves can disagree on `date`

Five pairs share an identical `snapshot_at` but land on `date` values one day
apart:

```
2024-05-28T12:00  msg14986 [1/2] → 2024-05-27   msg14987 [2/2] → 2024-05-28
2024-06-18T10:00  msg15531 (1/2) → 2024-06-17   msg15532 (2/2) → 2024-06-18
```

Part 1 is the previous-day wrap-up so `_parse_snapshot` dates it to D-1; part
2 happens to contain a running "Від початку цієї доби відбулося N бойових
зіткнень" sentence, hits `SAME_DAY_MARKERS`, and is dated to D. Since
`daily_combined` groups by `(source, date, snapshot_at)`, those halves **never
merge** — so the claim in `schema.sql` that the view COALESCEs the parts holds
for 69 pairs and fails for 5. It also puts 22 direction rows on the wrong day.

A stitched parse fixes this for free (one text, one date). Fixing it alone
would mean having a continuation part inherit its sibling's `date` rather than
running the day-marker heuristic over text that has no aggregate in it.

## Charting / consuming the data

For aggregate time series, query the **`daily_combined` view** — one row per
`(source, date, snapshot_at)` over the latest version of each post, with
continuation parts merged via `MAX()`:

```sql
SELECT date, snapshot_at, combat_engagements
FROM daily_combined
WHERE combat_engagements IS NOT NULL
ORDER BY date, snapshot_at;
```

For per-direction data, join `directions` to the latest post version directly
(`daily_combined` doesn't include directions — they're 1-to-many). The
`posts.part` column flags the rare late-2024 multipart splits: `NULL` for normal
posts, `"1/2"`/`"2/2"`/… for length-limit splits (part-1 carries the global
aggregates, part-2 the directions). A handful of older 2024 midday posts have no
global aggregate at all and show as NULL combat — `IS NOT NULL` handles them.

## Dependencies & caveats

Declared in `scripts/requirements.txt` (installed by the devcontainer):
`telethon` (only the API path; imported lazily so web/Nitter paths run without
it), `playwright` (Nitter→FB path only; needs `python -m playwright install
chromium`), `python-dotenv`. The **web preview path is stdlib-only**.

- **Telethon can't run in plain CI** — its first run needs an interactive phone
  login. CI uses the web-preview path instead; Telethon is for manual backfills.
- **Web preview / Nitter can be flaky** — t.me rate-limits and Nitter instances
  die. A failed run just succeeds on the next scheduled one (idempotent upsert
  with a 2-day lookback).
