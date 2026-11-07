# SBU «Альфа» monthly recap scraper (`scripts/sbu_alfa/`)

Builds **`data/sbu-alfa.db`** from SBU's monthly recaps — the **UA SBU ALFA —
MONTHLY RECAP** view of the app. Source: the monthly "ТОП-1 серед підрозділів
Сил оборони" recap the SBU's Centre of Special Operations «А» (Alfa) publishes,
starting March 2026, twice over with the same counters: as a press release at
[ssu.gov.ua/novyny](https://ssu.gov.ua/novyny/) and as a post on SBU's Telegram
channel, [t.me/SBUkr](https://t.me/SBUkr).

**Both are sources.** A recap is stored under the URL it was read from — the
article's, or `https://t.me/SBUkr/<id>` — and that is the link the page shows.
A month can hold both; the frontend reads one per month, the article where
there is one (`src/utils/sbuAlfaSources.ts`). The year of a post's recap comes
from its posting date, since a post's text names the month only ("у березні").

**Four paths, all stdlib-only:**

- **Telegram ingest** (`telegram.py` + `update-sbu-alfa-db.yml`) — the
  scheduled one. Walks the channel's public `t.me/s` preview newest-first back
  to the newest post already stored, daily during the plausible publication
  window (5th–20th of each month), and stores every post that passes
  `parse.is_monthly_recap` — a month detected AND at least `MIN_COUNTERS`
  counters, so nothing about the wording (TOP-1 or not) is assumed. The
  channel's search isn't exhaustive, so it isn't used.

  ```sh
  python3 scripts/sbu_alfa/telegram.py --out data/sbu-alfa.db
  python3 scripts/sbu_alfa/telegram.py --out data/sbu-alfa.db --pages 60 --rescan   # further back
  ```

- **Listing discovery** (`discover.py`) — manual only since Nov 2026. Scans the
  ssu.gov.ua news listing for recap slugs; it depends on an Akamai rule staying
  as loose as it is (see "Source quirks"), which is why the schedule doesn't.

  ```sh
  python3 scripts/sbu_alfa/discover.py --out data/sbu-alfa.db --pages 3
  ```

- **Manual ingest** of one recap — an article, a post, or a saved file:

  ```sh
  python3 scripts/sbu_alfa/ingest.py <article-url> --out data/sbu-alfa.db
  python3 scripts/sbu_alfa/ingest.py https://t.me/SBUkr/<id> --out data/sbu-alfa.db
  ```

- **Reparse** after a parser fix — re-reads the article text already stored in
  `reports.body_text` with the current parser, no fetch. Dry-run by default;
  `--apply` appends a new version of each report whose counters changed:

  ```sh
  python3 scripts/sbu_alfa/ingest.py --reparse --out data/sbu-alfa.db
  python3 scripts/sbu_alfa/ingest.py --reparse --apply --out data/sbu-alfa.db
  ```

  **This is the one that fixes a misread recap**, and the distinction matters
  (CLAUDE.md draws the same line for GSUA and Rubikon):

  | after a parser change… | the recap was | run |
  |---|---|---|
  | it was **dropped** — `is_monthly_recap` rejected it, so it was never stored | absent from the DB | a re-scan: `telegram.py --rescan --pages N` / the workflow's `rescan` + `pages` inputs (~12 pages a month back) |
  | it was **misread** — stored, but a counter line matched no category | in the DB already | `--reparse`; a re-scan re-reads identical text |

  Each half has its own workflow, split the way GSUA's are: `rescan` on
  **`update-sbu-alfa-db.yml`** (scheduled, ingests new recaps) for the first,
  **`reparse-sbu-alfa-db.yml`** (manual only, `dry_run` on by default) for the
  second. The reparse job pulls the DB from R2, prints the per-counter diff
  into the job summary so a dry run is readable without opening the step log,
  and uploads only when `changed=true` — so a dry run, or an apply that changed
  nothing, leaves R2 and the CDN cache alone.

  A row whose stored `report_type` the parser can no longer reproduce (a
  manual `--report-type` / `--period` override) is left untouched and reported,
  so a reparse can't quietly undo a human's curation.

The DB lives on R2 (bucket `russia-ukraine-war`, key `sbu-alfa.db`), pulled at
runtime by the frontend and by the workflow. Not committed to the repo.

**Source quirks.** The SBU site is fronted by Akamai which 403s most automated
requests (sitemap, search, pagination, `robots.txt`). `ingest.py` uses a
browser-like UA + headers that works for direct article URLs and for the
paginated news listing that `discover.py` scans — **with its trailing slash**:
since Nov 2026 the edge 403s `/novyny`, `/novyny?page=N` and `/en/novyny`
whatever the client (a real Chromium too), while `/novyny/` and
`/novyny/?page=N` serve the same listing. It is a path rule, not an IP or
user-agent one, so if discovery starts failing again, try path variants
before headers. A blocked listing page is a `sbu-alfa: listing fetch failed`
annotation. When SBU publishes a recap
via a mirror before it lands on ssu.gov.ua (early 2026 had this pattern —
[gorsovet.com.ua](https://gorsovet.com.ua/) and [5.ua](https://www.5.ua/)),
ingest the mirror manually as a stopgap and re-ingest from the canonical
`ssu.gov.ua` URL later; the older mirror row can then be deleted.

**Discovery filter.** `discover.py` matches slugs containing `alf[ay]` and
either the ranking (`top`, any or no rank number) or `syl-oborony` — loose on
purpose: the October 2026 slug dropped the `pidrozdiliv-` every earlier one
had, and a month the unit isn't TOP-1 would still get a recap, just not a
`top1` slug. The strictness is in the gate behind it: a candidate is stored
only if it parses as `monthly_top1` with a valid `period` and at least
`MIN_COUNTERS` (8) counters — every recap so far has 13–18 — so an ordinary
Alfa story that names a month can't pass for one. A gated-out candidate is a
`sbu-alfa: discovery candidate skipped` notice, for manual review.

**Drift detection.** `parse.py` also collects counter-like lines ("NUM
<Ukrainian noun>", inside the region the matched counters span) that no
category claimed, and `ingest.warn_unmatched()` — used by both the manual
ingest and `discover.py` — logs them through `scripts/ingest_log.py`. In CI
that becomes a **GitHub annotation** (`scripts/annotate_log.py` runs as the
job's last step) titled *sbu-alfa: unrecognised counter line*, anchored on
`parse.py`. The recognised counters are still stored; only the unclaimed line
is missing, so the failure mode is a quietly absent category — which is
exactly what the annotation is there to prevent.

## Schema

**`reports`** — one row per (url, scraped_at). `body_text` stores the cleaned
extracted text so we can re-parse later without re-fetching (important: SBU's
CDN is unfriendly and some mirror sites disappear).

**`counters`** — long-table of parsed counters keyed on (url, scraped_at,
category), so re-scraping an edited article inserts a new versioned row.
`reports_latest` / `counters_latest` views resolve the latest scrape per URL.

Bound model mirrors `scripts/missile_stockpile/reports.json` (the HUR view):

| `bound`     | Source phrasing                            | Example                          |
|-------------|--------------------------------------------|----------------------------------|
| `exact`     | bare number                                | `2218 безпілотників`             |
| `at_least`  | "понад", "більше", "over", `N+`            | `понад 10 200 піхотинців`        |
| `approx`    | "близько", "приблизно", "майже", `~`       | `майже 6 000 окупантів`          |
| `up_to`     | "до", "≤"                                  | (not yet seen)                   |
| `range`     | `value..value_max`                         | (not yet seen)                   |

The KIA number is always rounded and qualified: `at_least` ("понад N") in most
months, `approx` ("майже N") in others. The frontend notes each month's bound
in the tooltip ("Self-reported floor" / "Approximate"), so the reader knows the
count is not a precise figure.

## Tests

Golden-value pytest cases keyed on offline fixture HTMLs cover all categories
that have appeared so far:

```sh
python3 -m pytest scripts/sbu_alfa/test_parse.py -q
```

Add a new fixture under `scripts/sbu_alfa/fixtures/` and a stanza to
`test_parse.py` when a new month publishes with previously-unseen wording. The
HTML fixtures are tracked — `.gitignore` keeps only non-HTML out of that
directory — so a new one stages with a plain `git add`; a month whose HTML
isn't in the checkout skips (visibly) instead of erroring.

A lost fixture is recoverable from the DB: `reports_latest` carries every
ingested article's canonical URL alongside its `body_text`, so re-fetching the
URL reproduces the HTML (that's how March–May were restored, after an earlier
blanket ignore rule kept them out of the repo). Check the re-fetch against the
stanza's golden values before committing it — a press release edited since ingest would otherwise
move the goalposts silently.

## Schema caveats / drift

- **Vehicle bucketing** changed between April and May 2026: March/April split
  into `vehicles_light` + `vehicles_moto` + `vehicles_trucks`; May lumps them
  into a single `vehicles_auto_total`. We keep both shapes; the frontend
  renders whichever bucket(s) are present for each month.
- **Tank/IFV split** is sometimes omitted (March 2026 gives only the armored
  total). `armored_total` is always recorded; `tanks` / `ifvs` may be null.
- **Ukrainian case endings shift with the preceding numeral** — the noun after
  a count is genitive plural after 5+/0, nominative plural after 2/3/4, and
  nominative/accusative singular after a numeral ending in 1. Every category
  regex has to tolerate all three (August 2026 dropped two counters this way:
  "2791 антен**у** та вуз**ол** зв'язку" and "33 бойов**і** броньован**і**
  машин**и**"), which is why the patterns match stems + `\w+` rather than a
  single observed ending.
- **Sparse categories** (AD, radar, aircraft, watercraft, depots) appear only
  when the unit hits one that month. Absence is not zero — the chart renders
  an empty bar for that month.

## Self-report caveat

These are SBU's own claims of damage they've inflicted, not independently
verified counts. They overlap with — but are NOT a partition of — the
General Staff's national totals shown in **RU LOSSES**. Frame them in the UI
as `Self-reported by SBU Centre of Special Operations «А»`.
