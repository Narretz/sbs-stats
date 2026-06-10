# SBU «Альфа» monthly recap scraper (`scripts/sbu_alfa/`)

Builds **`data/sbu-alfa.db`** from SBU press releases — the **UA SBU ALFA —
MONTHLY RECAP** view of the app. Source: monthly "ТОП-1 серед підрозділів Сил
оборони" recaps the SBU's Centre of Special Operations «А» (Alfa) publishes at
[ssu.gov.ua/novyny](https://ssu.gov.ua/novyny), starting March 2026.

**Manual ingest, no scheduled workflow.** Unlike the other datasets, this has
no API and no Telegram channel we can subscribe to. When SBU publishes a new
monthly recap (usually mid-month, for the previous month), run:

```sh
python3 scripts/sbu_alfa/ingest.py <article-url> --out data/sbu-alfa.db
git add data/sbu-alfa.db
git commit -m "feat(sbu-alfa): add <month> recap"
```

The deploy workflow's `paths:` filter watches `data/sbu-alfa.db`, so the push
triggers a GitHub Pages build automatically. The DB is committed to the repo
(not on R2) — small file, infrequent edits, diffable in git.

**Source quirks.** The SBU site is fronted by Akamai which 403s most automated
requests (sitemap, search, pagination, `robots.txt`). `ingest.py` uses a
browser-like UA + headers that works for direct article URLs. If a canonical
SBU URL is unreachable, you can ingest from a mirror site that reproduces the
SBU text verbatim — the URL stored in `reports.url` becomes the mirror's URL
in that case.

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
| `approx`    | "близько", "приблизно", "майже", `~`       | (not yet seen in Alpha recaps)   |
| `up_to`     | "до", "≤"                                  | (not yet seen)                   |
| `range`     | `value..value_max`                         | (not yet seen)                   |

Every KIA number to date has been `at_least` (the recap always phrases it as
"понад N"). The frontend renders this with a "Self-reported floor" tooltip
note so the reader knows the count is a lower bound, not a precise figure.

## Tests

Golden-value pytest cases keyed on three offline fixture HTMLs cover all
categories that have appeared so far:

```sh
python3 -m pytest scripts/sbu_alfa/test_parse.py -q
```

Add a new fixture under `scripts/sbu_alfa/fixtures/` and a stanza to
`test_parse.py` when a new month publishes with previously-unseen wording.

## Schema caveats / drift

- **Vehicle bucketing** changed between April and May 2026: March/April split
  into `vehicles_light` + `vehicles_moto` + `vehicles_trucks`; May lumps them
  into a single `vehicles_auto_total`. We keep both shapes; the frontend
  renders whichever bucket(s) are present for each month.
- **Tank/IFV split** is sometimes omitted (March 2026 gives only the armored
  total). `armored_total` is always recorded; `tanks` / `ifvs` may be null.
- **Sparse categories** (AD, radar, aircraft, watercraft, depots) appear only
  when the unit hits one that month. Absence is not zero — the chart renders
  an empty bar for that month.

## Self-report caveat

These are SBU's own claims of damage they've inflicted, not independently
verified counts. They overlap with — but are NOT a partition of — the
General Staff's national totals shown in **RU LOSSES**. Frame them in the UI
as `Self-reported by SBU Centre of Special Operations «А»`.
