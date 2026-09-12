# SBU «Альфа» monthly recap scraper (`scripts/sbu_alfa/`)

Builds **`data/sbu-alfa.db`** from SBU press releases — the **UA SBU ALFA —
MONTHLY RECAP** view of the app. Source: monthly "ТОП-1 серед підрозділів Сил
оборони" recaps the SBU's Centre of Special Operations «А» (Alfa) publishes at
[ssu.gov.ua/novyny](https://ssu.gov.ua/novyny), starting March 2026.

**Three paths, all stdlib-only:**

- **Automated discovery** (`discover.py` + `update-sbu-alfa-db.yml`) polls the
  SBU news listing daily during the plausible publication window (5th–20th of
  each month, ~16 runs) and ingests any new recap:

  ```sh
  python3 scripts/sbu_alfa/discover.py --out data/sbu-alfa.db --pages 3
  ```

- **Manual ingest** for one-off backfills or when the discovery filter needs
  supervision (a themed article slipped through, an early canonical URL):

  ```sh
  python3 scripts/sbu_alfa/ingest.py <article-url> --out data/sbu-alfa.db
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
  | it was **dropped** — the slug filter or the `monthly_top1` gate rejected it, so it was never stored | absent from the DB | a re-scan, `--pages` / the workflow's `pages` input widened |
  | it was **misread** — stored, but a counter line matched no category | in the DB already | `--reparse`; `discover.py` skips URLs already stored, so a re-scan re-reads nothing |

  The workflow exposes both: `pages` for the first, the `reparse` checkbox
  (plus `dry_run`, on by default) for the second. The reparse step writes
  `changed=` like the scan does, so a dry run — or an apply that changed
  nothing — skips the R2 upload instead of busting the CDN cache.

  A row whose stored `report_type` the parser can no longer reproduce (a
  manual `--report-type` / `--period` override) is left untouched and reported,
  so a reparse can't quietly undo a human's curation.

The DB lives on R2 (bucket `russia-ukraine-war`, key `sbu-alfa.db`), pulled at
runtime by the frontend and by the workflow. Not committed to the repo.

**Source quirks.** The SBU site is fronted by Akamai which 403s most automated
requests (sitemap, search, pagination, `robots.txt`). `ingest.py` uses a
browser-like UA + headers that works for direct article URLs and for the
paginated news listing that `discover.py` scans. When SBU publishes a recap
via a mirror before it lands on ssu.gov.ua (early 2026 had this pattern —
[gorsovet.com.ua](https://gorsovet.com.ua/) and [5.ua](https://www.5.ua/)),
ingest the mirror manually as a stopgap and re-ingest from the canonical
`ssu.gov.ua` URL later; the older mirror row can then be deleted.

**Discovery filter.** `discover.py` matches slugs containing
`alf[ay]` + `top1` + `sered-pidrozdiliv-syl-oborony` (loose enough to survive
minor wording changes across the three known 2026 recaps, strict enough to
reject daily SBU news). Any candidate is parsed and gated on
`report_type == 'monthly_top1'` with a valid `period` before insertion, so a
false-positive slug can't land garbage — it surfaces as a skip warning in the
workflow log for manual review.

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
| `approx`    | "близько", "приблизно", "майже", `~`       | (not yet seen in Alpha recaps)   |
| `up_to`     | "до", "≤"                                  | (not yet seen)                   |
| `range`     | `value..value_max`                         | (not yet seen)                   |

Every KIA number to date has been `at_least` (the recap always phrases it as
"понад N"). The frontend renders this with a "Self-reported floor" tooltip
note so the reader knows the count is a lower bound, not a precise figure.

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
