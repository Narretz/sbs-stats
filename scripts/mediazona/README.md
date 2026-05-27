# Mediazona scraper — confirmed named deaths + probate-registry estimate

Builds **`mediazona.db`** from two weekly CSV exports of
[Mediazona](https://en.zona.media/) + Meduza's count of Russian war dead — the
**RU DEATHS — MEDIAZONA** view of the app.

**stdlib only** (`csv` + `sqlite3`), no extra dependencies.

```sh
# Re-export the two CSVs from a new Mediazona article into source/, then:
python3 scripts/mediazona/ingest.py --published-at 2026-05-22 --out data/mediazona.db
```

`--published-at` (YYYY-MM-DD) is the Mediazona article's publication date — the
source vintage the CSVs come from. It's analogous to `ru_losses`' `reported_at`.

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

The frontend reads the latest snapshot per week (`MAX(scraped_at)` join).

Two guards abort the build (without writing) on a broken input, so the R2
upload step is skipped: an absolute row-count floor (`MIN_ROWS_FLOOR`) and a
"no fewer weeks than already stored" check.

## Source / refresh

The two CSVs in `source/` are exports from Mediazona's published count. Automated
refresh from a live Mediazona source is **not wired** — Mediazona publishes via
infrequent articles, not a continuously-updated feed, so refresh is manual: drop
new CSVs into `source/` and re-run the ingest with the new article's
`--published-at`.

Mediazona also waits a long time between releases (e.g. the 2026-05-22 release
covers data through 2025-12-22 — a ~5-month gap, long enough for late-filing
probate records to start completing for H2 2025 so they can revise their flash
estimate before publishing).
