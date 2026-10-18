# Mediazona scraper — confirmed named deaths + probate-registry estimate

Builds **`mediazona.db`** from two weekly CSV exports of
[Mediazona](https://en.zona.media/) + Meduza's count of Russian war dead — the
**RU DEATHS — MEDIAZONA** view of the app.

**stdlib only** (`urllib` + `csv` + `sqlite3`), no extra dependencies.

```sh
# Default: fetch & parse the live Mediazona article bundle directly. The
# article URL changes per release; the script knows a known URL and discovers
# the hashed JS-bundle path inside it at runtime.
python3 scripts/mediazona/ingest.py --from-article --out data/mediazona.db

# Or override the URL (Mediazona's previous-release URLs stay alive):
python3 scripts/mediazona/ingest.py --from-article https://en.zona.media/article/2026/08/14/casualties_eng-trl

# Past releases (Mar 2023 →), from the bundles still on S3 — see "Past releases":
python3 scripts/mediazona/backfill.py --out data/mediazona.db
python3 scripts/mediazona/backfill.py --discover   # refresh releases.csv from Wayback

# Local-CSV mode (manual export workflow) — still supported:
python3 scripts/mediazona/ingest.py \
    --roles source/confirmed_losses_per_week.csv \
    --estimate source/probate_registry_estimate.csv \
    --published-at 2026-05-22
```

In CI (`update-mediazona-db.yml`; when it runs is in [CI.md](../../CI.md)) the
article URL is the workflow's `MEDIAZONA_ARTICLE_URL` env var, which overrides
`DEFAULT_ARTICLE_URL` here — when Mediazona publishes at a new path, bump that
env var; no code change. Each run re-pulls the whole bundle, append-on-change,
so a parser fix takes effect on the next run.

`--published-at` (YYYY-MM-DD) is the Mediazona article's publication date — the
source vintage the data comes from. It's analogous to `ru_losses`' `reported_at`.
In `--from-article` mode it's auto-derived from the bundle's `current_date`
metadata row; in local-CSV mode it's required.

## How the article fetch works

Mediazona embeds all chart data as inline `JSON.parse('…')` literals in the
chart's JS bundle (no XHR/fetch). The article HTML references that bundle by a
hashed S3 URL (`https://s3.zona.media/infographics/bodycount/main.<hash>.js.gz`)
that changes with each release. The ingest:

1. Fetches the article HTML and regexes out the bundle URL.
2. Downloads + gunzips the bundle, extracts every `JSON.parse('…')` literal.
3. Identifies the two relevant blobs **by shape** (not by index), so a
   reordering inside the bundle doesn't break us:
   - probate estimate: list of `{w, rnd, real}` dicts
   - roles daily series: either a flat dict-of-equal-length-int-lists
     (pre-Aug-2026) or the `{years, days, dates}` wrapper below
   - per-category summary (used only for the drift guard, below): list of
     `{k, o, v}` dicts.
4. Normalises the roles blob to one per-day series per role, then aggregates it
   into Thursday-anchored weekly buckets matching
   `confirmed_losses_per_week.csv`'s layout.

### The Aug-2026 roles re-encoding

The article published 2026-08-14 shipped a new bundle that broke the ingest:
the roles blob is now `{years: [...], days: N, dates: {index: [series, ...]}}`.
Two things changed at once.

- **A cohort breakdown.** Each role now carries one series *per entry in
  `years`* — the year in which those deaths were identified. Each cohort is
  still bucketed by date of death, so it spans the whole war but stops at its
  own year's end. The cohorts partition the dataset (they don't nest), so their
  elementwise sum is the all-time daily series the flat encoding used to carry.
- **Run-length encoding.** Inside a series a non-negative value is that day's
  count and a negative `-n` is a run of `n` zero days. Every series expands to
  exactly `days` entries; anything else aborts the build.

The index order survived the re-encoding, so `BLOB5_COLUMN_MAP` is unchanged —
re-verified both against the summary blob (the drift guard still reports its one
known `nd` miss and nothing else) and against the previously stored weeks, which
the summed series reproduces to within the ±1–2 per week that ordinary upstream
revision produces.
5. **Drift guard** (`_check_blob5_drift`): each role's all-time sum is held to
   its own category in the summary blob, matched by Russian name
   (`SUMMARY_NAMES`; `other` is "другие войска" plus every unlisted
   "(другие войска)" subcategory). The roles blob counts only deaths with a
   known date, the summary every name, so a role is compared with its summary
   total times the release's **dated share** — the median of the per-role
   ratios, ~0.82 in 2023 rising to ~0.97 in 2026. Across every release since
   Mar 2023 the per-role ratios stay within 0.74–1.14 of that median, except
   `nd` ("нет данных", 0.64–0.86); the guard allows 0.65–1.35 (`nd`:
   0.5–1.1), and roles under 100 an absolute ±40. A missing category or a role
   outside its band aborts the build — the signal that Mediazona
   added/removed/renamed a category and the column map needs revalidating.
   (It used to match each index to *any* summary total within 10 %, which
   every release before 2026 failed: their dated share was too low.)

### The 20-role layout (Mar 2023 – 06/12/2024)

Releases before 20/12/2024 carry 20 roles, not 21: "наземные авиаслужбы"
(`groundavia`) wasn't split out yet and its people sat in `other` — the
summary blob already listed it, as a "(другие войска)" subcategory. The other
roles are in the same order (`BLOB5_COLUMN_MAP_20`), picked by the blob's role
count; `groundavia` is 0 in those releases.

## Two independent series (two tables)

The source is **two distinct datasets** that must not be merged onto one axis —
different week anchors, different snapshots, different meaning:

### `weekly_roles` ← `source/confirmed_losses_per_week.csv`
Individually **confirmed, named** deaths, broken down by branch/role (`rifle`,
`mob`, `inmates`, `pmc`, `air`, …) plus `total`. Weeks are **Thursday-anchored**
(from the 2022-02-24 war start).

Bucketed by **date of death**, so the series is **right-censored**: recently
killed soldiers haven't been identified yet, and the weekly `total` decays toward
zero in the most recent weeks. That tail is *not* a real decline in deaths — the
frontend shades it and the chart shows **shares** (100 %-normalised), so the
composition story survives even where the absolute count is thin.

We store every role column verbatim; **grouping into the ~7 display buckets lives
in the frontend** (`MEDIAZONA_ROLE_GROUPS`, `src/types/index.ts`), so the
bucketing can change without a re-ingest.

### `weekly_estimate` ← `source/probate_registry_estimate.csv`
The probate/inheritance-registry statistical estimate (Mediazona + Meduza). CSV
columns `week, real, rnd` → table columns:

| Table column | CSV | Meaning | Cumulative |
|---|---|---|---|
| `documented` | `real` | **Recorded names count** (Mediazona/BBC) — named/confirmed deaths by week | ≈ 217,808 (the named list) |
| `estimate`   | `rnd`  | **Estimate of actual losses** — the all-in topline | ≈ 352,000 (the headline figure) |

Per the source chart's legend, `rnd` is the **"estimate of actual losses"**, which
is itself composed of: a **Probate-Registry estimate** + an **estimate of "late"
fatalities** (registered 180+ days after death, incl. court-declared) + a
**forecast** for the most recent ~6 months (the chart's "forecast for the second
half of 2025"). The export does **not** break those components out — we only have
the topline `rnd` and the `real` names count. So the ~90,000 "late"/court-declared
fatalities are **already included** in the ≈352,000 `estimate` (they are *not* a
later addition).

`documented` and `estimate` are **two independent measures of the same truth**,
not nested layers — `estimate` dips *below* `documented` in mid-2022, because the
estimate is a modelled redistribution rather than a count built on the named total.
The growing `documented`→`estimate` gap (≈ ×6 by late 2025) is the study's whole
point: the named list captures only ~45–65% of the modelled toll, worst for recent
(not-yet-identified) weeks.

Weeks here are **Monday-anchored** — a different grid from `weekly_roles`.

> ⚠️ The most recent ~6 months of `estimate` (H2 2025) are only **partly
> registry-backed** (probate filings take 180+ days to complete) and partly
> model-based, so values there will be revised in the next Mediazona release as
> more filings come in. Mediazona's published chart draws a separate "forecast"
> comparison line in that window; this export doesn't expose it. The frontend
> shades that window on the names-vs-estimate chart.

Note: the article's prose numbers, the two series here and the per-person atlas
are three different cuts of one list — see the reconciliation below.

## A third dataset — the 200.zona.media atlas (not ingested)

[200.zona.media](https://200.zona.media/) is the same project's **per-person**
list: the individual records behind the two aggregate series above. Not
currently ingested; documented here because it is the only public source for
per-name attributes, and because its totals are what reconcile the article's
prose numbers.

### How to get it

Static files under `https://s3.zona.media/infographics/g200w/` (brotli; any
client sending `Accept-Encoding: br` decodes them transparently):

| File | Content |
|---|---|
| `urls.json.br` | the roster — one slug per person, `Фамилия_Имя_Отчество_возраст`. **Array position is the person id** everywhere else |
| `atlas_64/atlas_N.csv.br` | `i,x,y` — person id → pixel offset in photo sheet N |
| `atlas_64/atlas_N.basis` | 4096×4096 Basis Universal (ETC1S) GPU texture of 64×64 portraits, transcoded in-browser by loaders.gl. A texture, **not data** |
| `output_singles/<slug>.jpg` | a single 64px portrait, no atlas decoding needed |
| `mosaic_indices.csv.br`, `distributed_markers.csv.br`, `location_names.csv.br` | photomosaic cell, map position (ints ÷ 100) and place labels |

Plus an undocumented JSON API on the site itself:

```sh
# list — needs at least one filter; an empty query returns []
curl 'https://200.zona.media/api/case?death=2026'
#   → [{"url":"…","name":"…","id":240198,"color":0}, …]

# full record, keyed by the urls.json slug
curl 'https://200.zona.media/api/case/Аликин_Максим_Анатольевич_18'
#   → {"name":"Аликин Максим Анатольевич","region":"Иркутская область",
#      "type":"добровольцы","rank":"рядовой","age":18,"birth":"10.07.2007",
#      "death":"20.06.2026#","source":"https://archive.ph/98Gib",
#      "locationId":54706099632,"locationName":"село Худоеланское","uid":"e68106…"}
```

Filters: `region`, `location`, `type`, `rank`, `death` (year), `age` (band),
`latest=true` (added since the previous release). `uid` is the stable key — the
slug embeds the age and changes on correction. Needs a browser `User-Agent`,
and rate-limits above a handful of concurrent requests.

`death` encodes its own provenance, which is worth preserving rather than
parsing away (shares from sampling the 2026-09-21 release):

- a trailing **`#` means the date came from official registries**, not from the
  obituary — the UI captions it "может отличаться от реальной". ~⅔ of all dates.
- `??.MM.YYYY` — day unknown, month and year known. Rare (<1 %).
- `null` — **no date at all, not a coarser one.** 300/300 sampled had no month
  and no week; a third of them do carry a birth date.

### How the totals reconcile

At the 2026-09-21 release:

| | |
|---|---|
| names in `urls.json.br` | 258,989 |
| … added since the 11 Sep release (`latest=true`) | 10,168 |
| … with a death year | 243,658 |
| … with no date of death at all | 15,331 |
| … with an age (slug ends `_NN`) | 244,803 — article prose: "244,700" |

`weekly_roles.total` resolved latest-per-week sums to **241,565**, which is the
article's *"the date of death is known in 241,600 cases"*: the atlas list minus
the records that can't be placed on a specific day.

### Differences to the two ingested series

- **Grain.** One row per person (region, place, branch, rank, age, birth,
  death, source) versus weekly aggregates with no identity.
- **Population.** The atlas and `weekly_roles` are the same list.
  `weekly_estimate.documented` is **not**: latest-per-week it totals 249,255
  through 2025-12-22, ~14.5k *more* than `weekly_roles` over that same window,
  and the excess sits entirely in 2024–25 (+7.2k each, ≈0 before). That is close
  to the 15,331 undated, so that line appears to place every known name on the
  axis — including those with no published date — to keep the comparison against
  the estimate fair. Don't read the two charts' totals as the same count.
- **Cadence.** Same bi-weekly release as the article (the atlas files carried
  the same 2026-09-21 date), but the atlas exposes its own delta via
  `latest=true`, which the CSV blobs don't.
- **Cost.** The roster is one ~1.9 MB request; the per-person attributes are one
  request each (259k), so a full pull needs a slow resumable crawl, then
  `latest=true` for each release's delta.

## Date model

Both CSVs label weeks `DD.MM.YYYY`; we store ISO `YYYY-MM-DD` as the week-start,
treated as Kyiv-local week markers (consistent with the other UA-sourced views).

## Rebuild semantics — append-only / edit-versioned

Mirrors the `ru_losses` and `gsua` model. A stored row is **never mutated or
deleted**. Each row is one *version* of a week's numbers, tagged with:

- **`scraped_at`** — UTC ingest timestamp (project-standard PK component).
- **`published_at`** — the Mediazona article date the CSVs came from (the source
  vintage; analogous to `ru_losses.reported_at`).

The primary key on each table is `(week, scraped_at)`. On every run the ingest
compares fetched values against the latest stored version per week and inserts
a **new row only when the values differ** (or the week is new). Re-running on
the same CSVs is a no-op; ingesting a fresh Mediazona release with a new
`--published-at` preserves the prior numbers and appends rows only where values
changed.

This matters because Mediazona publishes infrequently and **revises prior
weeks** each release as more probate filings complete (see the data-cutoff vs.
publication-date gap discussed below). Append-versioned storage preserves the
full historical development of the count across releases.

The **latest version** of a week is the one from the newest release
(`published_at`), then the newest ingest (`scraped_at`) — a release rebuilt
mid-cycle, or a parser fix re-reading the same release. Ordered by release
rather than by ingest because releases are not ingested in order: the backfill
adds old ones after newer ones are stored. The frontend (`useDatabaseMediazona`)
and the ingest's change detection (`latest_per_week`) use the same ordering,
and the ingest compares a release with the latest version **as of that
release**, so a backfilled one is compared with the release before it, never
with a newer one.

**Where each version came from** is in `releases`, one row per stored
`(published_at, scraped_at)` — a run that stores nothing adds none:

| Column | |
|---|---|
| `source` | `live` (the article, by `ingest.py`), `wayback` (a past bundle, by `backfill.py`; `scraped_at` is its capture time), `csv` (local exports), or `unknown` |
| `bundle_url` | the chart bundle on Mediazona's S3, still downloadable |
| `archive_url` | its Wayback capture |
| `note` | set when the row was filled in after the fact rather than recorded |

The table arrived after the backfill and the first live releases; `backfill.py`
fills in every version without a row, once. A backfilled version matches its
bundle in `releases.csv` exactly by capture time. One the live ingest stored
before the table existed (22/05 – 09/10/2026) gets the listed bundle with its
release date, noted as matched rather than recorded; the first, 22/05/2026, came
from CSV exports a day before its bundle's date, so it is `unknown` with that
bundle named. The app copy leaves the table out.

**The articles** each release was published in are in `articles`, one row per
page version `(url, captured)`, linked to `releases` by `bundle_url` (the chart
bundle the page embeds): the English article, dated per release since
28/03/2025 (`…/article/2025/03/28/casualties_eng-trl`) and before that one page
updated in place (`…/article/2022/05/20/casualties_eng`), and the Russian
`zona.media/casualties`, updated in place throughout and carrying the
biweekly summary text. Russian is the original (the English URLs end in
`-trl`), and the only article for some releases: May–August 2022, before the
English page, and a few later ones no English capture shows. On days with two
bundles Mediazona built one per language (the same data, translated labels), so
a release's two pages can embed different bundles — `releases` points at the
one stored first. Columns:

| Column | |
|---|---|
| `source`, `lang` | `wayback` / `live`; `en` / `ru` |
| `archive_url` | the Wayback capture the page was taken from (none for a live fetch) |
| `url_date` | the date in a dated English URL |
| `headline`, `headline_date`, `headline_count` | the page's og:description ("Over 5 801 deaths confirmed by August 25", "Больше 6,2 тысяч смертей к 9 сентября") and the date and count parsed from it — a year-less date gets the latest year on or before the capture |
| `list_updated`, `estimate_updated` | "Last update to the named list / to the Probate Registry estimate" (and the Russian equivalents), where the page has them |
| `title`, `text` | og:title; the visible text from the `<h1>` to the footer |
| `html` | the whole page, zlib-compressed |

A live run that stores a release keeps the English page it fetched and the
Russian one (a failure on the latter is a warning). For the past,
`backfill.py --discover` matches each bundle to an archived capture of each
article that embeds it — of the five captures nearest the bundle's own, the
first naming it — and records the pair in `releases.csv`; `backfill.py` then
stores those pages (cached in `output/articles/`).
The headline gives a date and a count for every release, the 2022 ones whose
bundles aren't decoded too, and it is the article's date: `url_date` is only the
URL's. Mediazona didn't always open a new dated URL — the 11/04/2025 release
went into the 28/03 page, 09/05 and 23/05/2025 into the 25/04 page, and
03/07/2026 appeared first on the 19/06 page.

Coverage (the 18/10/2026 discovery): the English article matched 102 of the
133 bundles and the Russian one 115; every stored release version has at least
one page (79 English, 84 Russian). The misses are mostly a release's second
bundle, whose captures show the first. Of the headlines, five carry no
parseable date ("за 100 дней войны", "к году войны", a "June 39" typo, the May
2026 estimate headline). The app copy leaves the table out; it is most of
the full DB's growth (~27 KB a page compressed).

A week can also **disappear**: the 24/04/2026 release dropped the estimate's
trailing partial week (2025-08-18), which the release before had shown. Since
a row is never deleted, the ingest stores an empty row (`documented` and
`estimate` both NULL) for a week the release no longer has; the frontend skips
empty rows. Up to `MAX_DROPPED_WEEKS` (2) per release — more is a broken
export.

Guards abort the build (without writing) on a broken input, so the R2 upload
step is skipped: a row floor of half the war's weeks at the release
(`min_rows` — scaled because a 2023 release covers barely 55 weeks), a "no
fewer weeks than already stored" check on the roles, and that check less
`MAX_DROPPED_WEEKS` on the estimate.

## Past releases (backfill)

Every release's chart bundle is still on Mediazona's S3 at its hashed path;
only the article page moves on. The Wayback Machine captured most of those
paths: `releases.csv` lists the 133 bundles it knows (May 2022 → today) with
their first capture, and `backfill.py --discover` refreshes it from Wayback's
index. `backfill.py` downloads each (S3, Wayback as the fallback; cached in
`output/bundles/`), parses it with the live ingest's `parse_bundle`, and stores
those **older than the oldest release in the DB**, in release order. Newer ones
are the live ingest's; re-running is a no-op. In CI it is the `backfill` input
of `update-mediazona-db.yml`, which runs it only on the DB downloaded from R2.

- **Coverage.** The 106 bundles from 10/03/2023 on decode. 93 of them predate
  the first release the live ingest stored (22/05/2026): 77 release dates —
  a few of them mid-cycle rebuilds — from 10/03/2023 (roles only, 20-role
  layout) to 09/05/2026. The
  probate estimate starts 16/02/2024 (published with the 24/02/2024 study).
  Bundles before Mar 2023 are a different encoding — role totals and
  per-region day series, no per-role days — and are skipped.
- **Release date.** The estimate blob's `current_date` row, which exists from
  Apr 2024. The roles series always runs from the war's start to the release
  day, so `WAR_START + days` matches `current_date` to within a day on every
  release that has both, and dates the releases without one. Where they
  disagree by more, the series wins: Mediazona sometimes rebuilt a bundle
  mid-cycle with newer data under the old date (13/05/2025 shipped data to
  10/05 dated 25/04), which would otherwise be ordered before the release it
  follows. The 24/02/2024 bundle, the estimate's debut, carries data to 16/02
  and is dated so.
- **`scraped_at`** of a backfilled row is the bundle's Wayback capture time —
  when that version was seen live — not the backfill's run time. It orders a
  release's rebuilds and keeps each bundle's rows apart under the
  `(week, scraped_at)` key.
- **Size.** The history multiplies the DB: 0.57 MB → 2.7 MB (12k roles rows, 9k
  estimate rows). The app doesn't read it: it reads the app copy below.

## App copy

CI uploads two objects: `mediazona.db`, the full history above, and
`mediazona.app.db`, which the frontend reads in production — the same schema
with only each week's latest version (`app_db.sql`, run by
`scripts/build_app_db.py`), ~0.1 MB. The app shows nothing else yet; a chart of
how the count developed across releases would read the full DB. `app_db.sql`
uses the same ordering as `latest_per_week` and the hook, and `test_ingest.py`
holds the copy to the full DB's latest view. Dev reads the full DB
(`data/mediazona.db`): it is a whole fetch either way, and the same query gives
the same rows.

## Source / refresh

Two paths:

- **`--from-article`** (default): pulls from the live article bundle and
  drops the manual CSV step entirely. Suitable for an automated bi-weekly
  workflow. The known article URL is hardcoded; if Mediazona retires it
  (historically they leave old URLs alive and publish new releases at fresh
  paths), update `DEFAULT_ARTICLE_URL` in `ingest.py`.
- **Local CSVs in `source/`**: the historical workflow — drop fresh exports
  in and run with `--roles --estimate --published-at`. Useful for one-off
  reproductions against an exact archived release.

Mediazona waits a long time between releases (e.g. the 2026-05-22 release
covers data through 2025-12-22 — a ~5-month gap, long enough for late-filing
probate records to start completing for H2 2025 so they can revise their flash
estimate before publishing).
