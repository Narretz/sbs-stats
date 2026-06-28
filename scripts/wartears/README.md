# Wartears scraper — Ukrainian AFU personnel & casualty index

Builds **`wartears.db`** from [wartears.org](https://wartears.org)'s daily xlsx
snapshot — a crowdsourced index of identified Ukrainian Armed Forces (AFU)
personnel and affiliates, with status tags for confirmed-dead, captive, and
missing where known.

Requires **`openpyxl`** (the xlsx is a 65 MB zip of XML; we stream the 246k-row
records sheet with `read_only=True` to keep memory flat).

```sh
# Fetch the latest xlsx from upstream and rebuild the DB:
python3 scripts/wartears/ingest.py --out data/wartears.db

# Or against a local copy (e.g. one already in sources/):
python3 scripts/wartears/ingest.py --in sources/wartears-opendata.xlsx
```

## Source

`https://wartears.org/static/wartears-opendata.xlsx` — single workbook,
regenerated nightly. Five sheets, Russian-named (the only canonical form):

| Sheet | Meaning |
|---|---|
| `Метаданные` | snapshot generation timestamp |
| `Записи` | **records** — persons (`kind=1`), organisations (`kind=2`), other (`kind=3`); 8 tag cells + 8 free-form attribute pairs + 4 image URLs per row |
| `Теги` | tag lookup (id → name) |
| `Отношения` | oriented graph edges between records (e.g. "serves-in", "is-part-of") |
| `Разновидности отношений` | relationship-kind lookup |

The canonical tags are **`Погиб`** (DEAD) and **`В плену`** (captive); other
common ones include `Пропал` (missing), `Дедупликация` (dedup workflow flag),
`Погибшие офицеры` (dead officers), `Еленовка` (Olenivka POW camp), and many
`Обмен YYYY-MM-DD` POW-exchange batches.

## Schema

Records are split into a head table plus three normalised side-tables so
"all DEAD persons" is an indexed scan, not a JSON unbag:

| Table | Purpose | Key |
|---|---|---|
| `records` | one row per `(id, scraped_at)` version | `(id, scraped_at)` |
| `record_tags` | one row per tag on a record-version (indexed on `tag`) | — |
| `record_attrs` | free-form attribute pairs per record-version | — |
| `record_images` | image URLs per record-version | — |
| `tags` | id → name lookup (replaced wholesale) | `id` |
| `relationships` | edges (replaced wholesale, no history) | `id` |
| `relationship_kinds` | edge-kind lookup (replaced wholesale) | `id` |
| `source_meta` | snapshot generation timestamp (replaced wholesale) | `key` |

## Rebuild semantics — append-only / edit-versioned

Mirrors the `mediazona` / `ru_losses` / `gsua` model. `records` rows are **never
mutated or deleted**; an upstream edit appends a new version keyed by ingest
time. We use **wartears' own per-record `updated_at`** as the change signal —
a fetched record whose `updated_at` matches the latest stored version is
skipped, so a daily re-fetch of an unchanged record costs nothing.

Tags, attributes, and images are versioned **alongside the record** (same
`scraped_at`), so a record-version is a self-contained snapshot. The frontend
reads the latest version per id (`MAX(scraped_at)` join).

Lookup tables (`tags`, `relationships`, `relationship_kinds`, `source_meta`)
are tiny and not historically interesting — replaced wholesale each run inside
the same transaction.

The whole write is one transaction with two guards that **rollback** if they
trip: an absolute records floor (`MIN_RECORDS_FLOOR = 100_000`, vs ~245k actual)
and a "no fewer fetched records than already stored" no-shrink check. A broken
upstream leaves the DB untouched.

## Date model

Each record carries its own `updated_at` (date-only ISO). Records aren't
bucketed onto a time axis — the dataset is a roster, not a time series.

## What this dataset is — and isn't

It's a **roster of identified AFU-affiliated persons**, not a casualty
database. As of 2026-06-28:

| | count |
|---|---:|
| total records | 246,050 |
| └ persons (`kind=1`) | 245,030 |
| └ organisations (`kind=2`) | 1,010 |
| └ other (`kind=3`) | 10 |
| tagged `Погиб` (DEAD) | 73,946 |
| tagged `В плену` (captive) | 29,468 |
| tagged `Пропал` (missing) | 10,537 |
| **untagged entirely** | **127,623 (~52%)** |

The 127k untagged records are real upstream data — the parser is verified
against the raw xlsx. Of those, only ~3,200 contain death/captive/missing
keywords in their `public_info` free-text (i.e. genuine tagging lag); the
other ~124k have neither tags nor status-implying text, and are simply
identified persons whose fate is unknown or unrecorded.

## A note on wartears' published "estimated total losses"

Wartears headlines an *estimated total Ukrainian dead* well above the
auditable `Погиб` count in the DB, derived from a published [math
model](https://wartears.org/en/posts/math-model/). The estimator is a
capture-recapture-style formula:

```
T = R · Q / A
```

- `R` = records in the DB tagged in that category (our 73,946 DEAD)
- `Q` = total search requests filed by relatives looking for a missing person
- `A` = of those, how many turned out to be in the DB in that category
- `T` = inferred total in the population

The intuition: if relatives' searches hit the DB at rate `A/Q`, assume the DB
covers that same fraction of the population, and divide `R` by it. This works
under classical Lincoln–Petersen assumptions — two **independent random
draws** from a closed population — but in this dataset:

1. **The two samples aren't independent.** Search requests filed by relatives
   are *themselves a documented source* of DB records ("3,000+ search requests"
   per the methodology), so the two populations are mechanically correlated
   even if request-originated records are excluded from `R`.
2. **The relatives' search base isn't a random sample of the population.**
   Relatives file searches when status is **unknown** — not for confirmed-living
   or confirmed-dead. The implied A/Q hit rate is computed on a self-selected
   subgroup that's structurally different from the population it's projected onto.
3. **`R` itself is a lower bound that the model treats as ground truth.**
   The 127k untagged records show that the DB's structured tagging lags its
   free-text collection; anything that depresses `R` also depresses `T`.
4. **The "duplicates could significantly lower the total" caveat has the wrong
   sign.** Duplicates inflate `R`, which inflates `T`. The only way duplicates
   reduce `T` is if they inflate `A` faster than `R` — possible but unexplained.
5. **`A` and `Q` are never published.** Without them, `T` can't be reproduced
   or audited — readers only see the headline number.
6. **The authors themselves note actual losses "may be twice as high"** as
   their estimate — an admission of one-sided underestimation (the true `T`
   could be up to 2× their headline), not a symmetric error bar. Combined
   with the other downward pressures above (lagging tags depressing `R`,
   relatives-search bias toward unknown-fate cases), the published `T` is
   presented as a *floor* with no stated ceiling.

Bottom line: the `R` column in this DB (e.g. 73,946 `Погиб`) is an auditable
lower bound of *confirmed-by-wartears named dead*. Wartears' headline
estimate `T` is a model output sitting on top of undisclosed inputs and
non-independent samples; treat it as a directional heuristic, not a
measurement. This view shows the auditable counts only.
