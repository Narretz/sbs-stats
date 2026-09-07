# «Рубикон» monthly scrapers (`scripts/rubikon/`)

Builds **`data/rubikon.db`** from the Telegram channel of the Russian UAV unit
**Центр «Рубикон»** ([@icpbtrubicon](https://t.me/icpbtrubicon)).

**Two independent monthly series** live in that one DB, split by
`reports.report_type`, each with its own site in the app:

| `report_type` | Parser | Posted | Counts | In the UI? |
|---|---|---|---|---|
| `monthly` | `parse.py` | 3rd–4th | Targets the unit **claims to have engaged**, per the General Staff's plan | ✅ site `rubikon` |
| `monthly_digest` | `parse_digest.py` | last day / 1st | Strike videos the channel **published** | ❌ stored only |

Both are scraped and stored by the **same** `ingest.py` run — `parse_any()`
tries the recap parser, then the digest parser, on every post it walks. There
is no separate command and nothing manual.

They are **not two formats of one thing** — see [Two series, not one](#two-series-not-one).
Everything else the channel posts (~200 messages/month of combat footage,
recruiting, milestone tallies, direction-scoped totals) is ignored.

## 1. The General-Staff recap (`report_type='monthly'`)

```
🔴 Применение Центра «Рубикон» по плану начальника Генерального Штаба
   с 1 по 31 августа 2026 года.

Выполнено 124 720 боевых вылетов.

Поражены:

Живая сила - 538
Танки - 5
…
Наземные дроны - 1 036

Также системами РЭБ было подавлено 5 672 вражеских дронов.
```

**Backend: the public `t.me/s` web preview** — plain HTTP + HTML, stdlib only,
**no Telegram API account needed** (same approach as `scripts/ru_mod`).

```sh
# incremental — what CI runs; 3 preview pages ≈ the last week of the channel
python3 scripts/rubikon/ingest.py --out data/rubikon.db

# historical backfill — the monthly series starts with the 2026-01 recap
python3 scripts/rubikon/ingest.py --out data/rubikon.db --backfill

# re-parse already-stored post text after a parser fix (no re-fetch).
# Dry run by default; --apply writes (mirrors reparse-gsua-db.yml's dry_run input).
python3 scripts/rubikon/ingest.py --out data/rubikon.db --reparse
python3 scripts/rubikon/ingest.py --out data/rubikon.db --reparse --apply
```

The DB lives on R2 (bucket `russia-ukraine-war`, key `rubikon.db`), pulled at
runtime by the frontend and by the workflow. Not committed to the repo.

### Three kinds of number, kept apart

Rubikon says **«Поражены»** — *engaged* — with **no destroyed/damaged split**
(same as the SBU Alfa recap). But not every number in the post is a target
engaged, so each counter carries a `kind`:

| `kind`          | Source line                                        | Meaning |
|-----------------|----------------------------------------------------|---------|
| `sorties`       | `Выполнено N боевых вылетов`                       | Unit activity — sorties flown, not damage. |
| `engaged`       | every `Label - N` line under `Поражены:`           | Targets the unit claims to have hit. |
| `ew_suppressed` | `системами РЭБ было подавлено N вражеских дронов`  | Drones **jammed by EW**, i.e. NOT kinetically engaged. |

`ew_suppressed` is the one the UI must never let a reader fold into the
"engaged" total — the monthly page renders it in its own section with a caveat
note on every bar. `sorties` is likewise charted apart from the target grid.

### Categories

Canonical keys and their Russian source labels live in `CATEGORY_ALIASES`
(`parse.py`); the English chart labels live in `RUBIKON_CATEGORY_LABELS`
(`src/types/index.ts`) and **reuse the app's existing wording** wherever the
category is semantically the same as one already charted elsewhere (e.g.
`Букс. арт. оруд.` → SBS's "Cannons, Howitzers", `Наземные дроны` → "UGVs",
`Пункты управления БПЛА` → SBS's "Drone Launch Points").

Three source quirks worth knowing:

- **`РЛС, РЭР, РЭБ` is one bucket** in the source — radar, SIGINT and EW
  counted together. We keep it as one counter (`radar_ew`) rather than
  inventing a split the source doesn't make.
- **`Огневые средства` is a residual bucket.** Literally "fire assets" —
  anything that delivers fire. But the same list already counts mortars, towed
  guns, SPGs, MLRS, ATGMs, SAMs and AA guns on their own lines, so what lands
  here is what's left: crew-served infantry weapons (HMGs, AGS) and firing
  points the unit didn't classify further. The counts fit — 1–7 a month, with
  one 51 outlier in Jul 2026. We label it **"Crew-Served Weapons"**; that's our
  reading of the term, not a translation, and the DB key stays literal
  (`fire_weapons`).
- **Sparse categories** appear only in months the unit hit one: `atgm` (Feb),
  `sam` / `aa_guns` (Mar), `fixed_wing_uav` (Feb, Mar), `command_posts`
  (Jan, Mar). Absence is not zero — the chart draws an empty bar.

### Rejecting non-recap posts

`parse.py` gates on the headline reading **`с 1 по <last day of month> <month>
<year>`** — a full calendar month. That single anchor is what keeps the
channel's other totals out of the monthly series, most importantly the
30 Dec 2025 post, which has the same headline family and a full `Поражены:`
list but covers *14 April – 30 December 2025 on the Krasnoarmeysk axis*.
Folding that in would add a ~9-month cumulative total as if it were one month.
It's kept as a negative fixture (`fixtures/non-recap-post899.txt`).

## 2. The «Итоги» published-episode digest (`report_type='monthly_digest'`)

> **Stored, not shown.** No page reads this series. These are **Lostarmour's
> numbers** — Lostarmour catalogues and classifies Rubikon's published strike
> videos (every Rubikon post footer links «Статистика «Рубикона» на
> Lostarmour»), which is where the coarser, unfamiliar category set comes
> from. If we want this measure, it should come from Lostarmour directly
> rather than from Rubikon's monthly prose summary of it, which is spotty:
> 13 months, one missing, per-category detail for only 6 of them in two
> different shapes, three headline figures that are floors.
>
> The ingest keeps collecting it anyway — it's free (same scrape, same posts)
> and it means the history is there if the Lostarmour route opens up. The
> frontend still carries the row types and a `queryEpisodes` read path,
> unused, so re-adding a view is a small change.

At the end of each month (or on the 1st) the channel posts «Итоги <месяца>»:

```
🪖 Рубикон. Итоги ноября.
Количество опубликованных эпизодов поражения целей противника операторами
Центра "Рубикон" в ноябре 2025 составило 2245, …
Структура основных типов пораженных целей в ноябре 2025 и динамика
относительно октября 2025:
• БПЛА - 664 (-8%)
• НРТК - 87 (-33%)
…
• Прочие цели - 13
```

Coverage — **2025-07 → 2026-08**, wider than the recap but thinner:

| Months | Headline | Categories |
|---|---|---|
| 2025-07, 2025-08 | ✅ (a floor — «превысило N») | ❌ |
| 2025-09 … 2025-11 | ✅ | ✅ 10–11 |
| **2025-12** | **❌ skipped** — replaced by the annual «Итоги 2025» | ❌ |
| 2026-01 … 2026-03 | ✅ | ✅ 10–11 |
| 2026-04 … 2026-08 | ✅ (2026-08 a floor) | ❌ dropped |

Counter kinds: `published_total` (the headline) and `published_episodes` (one
per structure-list line). `counters.bound` is `at_least` where the post says
«превысило N» rather than «составило N».

**Every published breakdown sums exactly to its own headline** — six for six.
The parser checks it and warns on a mismatch, and `test_parse_digest.py`
asserts it, so a dropped or double-counted bullet fails loudly.

### Two series, not one

The digest looks like a coarser recap. It isn't, and the overlap months prove
it: **Jan/Feb/Mar 2026 each have both**, posted days apart, disagreeing ~4×.

| Category (mapped onto recap keys) | 2026-01 | 2026-02 | 2026-03 |
|---|---|---|---|
| Tanks | 19 / 20 = **0.95** | 7 / 11 = 0.64 | 13 / 20 = 0.65 |
| Armour (ББМ + БТР) | 110 / 182 = 0.60 | 70 / 237 = 0.30 | 158 / 341 = 0.46 |
| Artillery | 51 / 84 = 0.61 | 53 / 92 = 0.58 | 67 / 104 = 0.64 |
| UAVs | 438 / 1212 = 0.36 | 525 / 1695 = 0.31 | 1160 / 3578 = 0.32 |
| Radar + comms | 385 / 1575 = 0.24 | 312 / 1356 = 0.23 | 603 / 2125 = 0.28 |
| Personnel | 166 / 1308 = **0.13** | 208 / 1297 = 0.16 | 219 / 1798 = 0.12 |
| ПВД + fortifications | 433 / 2503 = 0.17 | 312 / 2943 = 0.11 | 433 / 4418 = **0.10** |
| **TOTAL** | 2152 / 8470 = 0.25 | 1857 / 9121 = 0.20 | 3299 / 14842 = 0.22 |

A coarser count of the same thing would give a roughly constant ratio. This
spans **0.10 to 0.95 inside a single month** — publication selection: a
destroyed tank gets filmed and posted nearly every time, a hit dugout almost
never. Post 2551 prints both totals side by side: **280 000** targets hit vs
**45 000** published episodes over the same 20 months.

Hence: separate `kind`, separate categories namespace, separate page, never a
shared axis.

### Digest source quirks

- **Post 481 («Ударное лето», Aug 2025)** has a bulleted list, but it's a
  **three-month** Jun+Jul+Aug aggregate. The gate is the
  `Структура основных типов пораженных целей` header, which only the true
  monthly posts carry — without it, a quarter's worth of kills would land on
  August. Covered by `test_summer_aggregate_bullets_are_not_august`.
- **Post 2260 has a source typo**: titled «Итоги июля 2026», body says
  "в июне 2026 составило 4900". June was already reported as 5232 by post
  1986, and 2260 was posted on 31 July — so the **title wins** on the month
  and the discrepancy is logged as a warning.
- **November 2025 was posted twice** (786 and 787, identical figures,
  different leading emoji). Both are stored; the frontend query picks the
  lowest `post_id` per period.
- **Category shape drifted twice**: Sep/Oct 2025 split artillery into
  `Буксируемые орудия` + `САУ` (merged to `Артиллерийские системы` from Nov);
  March 2026 added `Взаимодействие с ВКС` (joint strikes with the Aerospace
  Forces), which counts inside that month's headline.
- **Not ingested** from the same family: the annual «Итоги 2025» (post 903 —
  a full-year total, would land on a monthly axis), and the cumulative
  "N 000 эпизодов" milestone posts (percentages, no month). Both are kept as
  negative fixtures.

## Schema

Append-on-change and edit-versioned, mirroring `scripts/sbu_alfa` and
`scripts/ru_mod`:

- **`reports`** — one row per `(post_id, scraped_at)`. `body_text` stores the
  raw post so a later parser fix can be applied with `--reparse` instead of
  re-scraping (a re-scrape re-ingests identical text and changes nothing).
- **`counters`** — long table keyed on `(post_id, scraped_at, category)`, with
  `kind`, `value`, `bound` (`exact` / `at_least`) and the verbatim `raw_label`.
  The two series have separate category namespaces: the digest's `uav` is a
  coarser bucket than the recap's, so they must never be summed together.
- **`reports_latest` / `counters_latest`** — resolve the latest `scraped_at`
  per post; all frontend reads go through these.

A re-scrape that parses to identical counters inserts nothing, so the daily CI
poll only writes (and only re-uploads to R2) when the recap actually lands or
is edited.

## Tests

```sh
python3 -m pytest scripts/rubikon/test_parse.py scripts/rubikon/test_parse_digest.py -q
```

(Run them together — the two files have distinct basenames, unlike the repo's
several `test_ingest.py`, so pytest can collect both in one go.)

Golden values for all eight recaps (2026-01 … 2026-08) and all thirteen
digests (2025-07 … 2026-08), plus drift checks (no unmatched list line), kind
separation, the sums-to-headline invariant, and every rejection case —
including a cross-check that **neither parser accepts the other's posts**.
Add a fixture under `fixtures/` and a `GOLDEN` stanza when a new month
publishes with previously-unseen wording.

## Self-report caveat

These are **Rubikon's own claims** about damage they inflicted, not
independently verified counts. They overlap with — but are not a partition of —
any other view in this app. Frame them in the UI as self-reported.
