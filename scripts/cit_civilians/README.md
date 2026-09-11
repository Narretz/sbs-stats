# CIT civilian casualties (`scripts/cit_civilians/`)

Builds **`data/cit-civilians.db`** from the daily civilian-casualty summaries
published by the **Conflict Intelligence Team** on
[@CIT_shellings](https://t.me/CIT_shellings).

**Backend: the public `t.me/s` web preview** — plain HTTP + HTML, stdlib only,
no Telegram API account. Same approach as `scripts/ru_mod` and
`scripts/rubikon`.

```sh
# incremental — what CI runs
python3 scripts/cit_civilians/ingest.py --out data/cit-civilians.db

# full history (the summary format starts 2023-10-16, ~10,800 posts)
python3 scripts/cit_civilians/ingest.py --out data/cit-civilians.db --backfill

# re-read stored post text after a parser fix (dry run; --apply writes)
python3 scripts/cit_civilians/ingest.py --out data/cit-civilians.db --reparse

python3 scripts/cit_civilians/check_db.py --db data/cit-civilians.db --since 2026-09-01
python3 -m pytest scripts/cit_civilians/test_parse.py -q
```

## The source post

One post a day, covering 20:00–20:00 **MSK**:

```
Всего за прошедшие сутки (20:00 07.09.2026 – 20:00 08.09.2026):

в Киевской области вследствие атак ракетами и БПЛА погибли семь человек,
ещё 42 пострадали, включая двухлетнюю девочку.
…
на оккупированной территории Донецкой области … погибли три человека, ещё 20 …
…
Кроме того, стало известно о ещё одном пострадавшем в Харьковской области
за 7 сентября, …

Таким образом, за прошедшие сутки стало известно как минимум о
26 погибших и 165 пострадавших мирных жителях.
```

The window straddles two calendar days but puts 20 of its 24 hours on the end
date, so **`report_date` is the end date**.

**At the weekend there is one post for two days** — `Всего за прошедшие
выходные`, a 48-hour window. Those are ~15% of summaries but ~26% of days, so
they are parsed too, as `report_type='weekend_summary'` with `window_days=2`.
A 48-hour bucket must never be drawn as a single day's toll.

### Charting a weekend post

Split it in the chart layer, never in the DB — storing 15.0 and 15.0 would lose
the fact that CIT never said that. In a bar chart the honest encoding is one
bar spanning both days at the **daily-average** height, so the bar's *area*
equals the true total (a histogram with one unequal bin); hatch it and name
both dates and the real figures in the tooltip. In a line chart, plot the
average at both dates with hollow markers. What not to do is attribute the
whole 48 hours to the end date: every Sunday becomes a spike and every Saturday
a zero, across a quarter of the series.

Only the raw daily view needs this. Weekly, 7-day rolling and monthly
aggregates just sum window totals into buckets. Later corrections also name
exact dates inside the weekend ("за 3 и 4 сентября"), so `daily_revised`
already places those precisely — only the bulk figure needs spreading.

**Monthly aggregation: bucket by `report_date`** (the window's end date). A
Friday 20:00 → Sunday 20:00 window can straddle a month boundary a few times a
year; those weekends count wholly into the month their end date falls in,
rather than being split proportionally. Decided deliberately — the error is
small, bounded, and a rule you can state beats one you have to reconstruct.

**Long posts are split.** Over Telegram's 4096-character limit CIT continues in
the next message, and the corrections and the closing total routinely land
there (post 10889 → 10890). A summary is stored under its head `post_id` with
`part_ids` naming every post it was assembled from.

## Read this first: which number to chart

`reports.stated_killed` / `stated_injured` come straight off the closing
"Таким образом" sentence. **That is the series to plot** (view
`daily_stated`). Measured over the full archive — 885 posts, 1,061 covered
days, 2023-10-18 to 2026-09-10 — it parses on **100% of posts from 2024
onward**; the only gap is the 64 posts of the 2023 era, which carry no total
line at all.

The per-region rows in `casualties` are the secondary dimension, and they are
better than the strict flag suggests:

| Over 817 posts with a total line | |
|---|---|
| killed column matches the post's own total exactly | **82%** |
| injured column within 3 people | **89%** |
| both exactly (`reports.reconciled`) | **50%** |
| aggregate drift across the archive | killed **+0.9%**, injured **−1.0%** |

So the breakdown is accurate in aggregate to about a percent, while rarely
matching to the person on any given day — injured is the soft column, typically
off by one or two in a figure of a hundred-odd. `reports.reconciled` records
the strict test per post; `check_db.py` reports all of it. Where a post does not
reconcile the headline is still correct — only the breakdown for that day is in
doubt.

Weekend posts reconcile worse than weekday ones, and not because of the
stitching: both in the sample were single complete posts whose every paragraph
parsed, with crisp modern-format lines (`ещё 31 пострадал`), and the breakdown
still came to 159 injured against a stated 171. A 48-hour post compresses two
days into the same terse region list, and more people end up in the headline
than in the prose.

That gap is not all parser error. Some posts genuinely disagree with
themselves: for post 10889 every region line was verified clause by clause and
sums to 229 injured against a stated 230. Three such posts are pinned in
`test_parse.py::NON_RECONCILING` so nobody later "fixes" the parser to
reproduce a source typo.

Watch the trend, not the level. A drop in the killed-exact rate, or aggregate
drift beyond a couple of percent, means the format moved; a strict percentage
on its own would hide both.

## The three row kinds

| `kind` | What it is | In the checksum? |
|---|---|---|
| `daily` | the window's own regional rows | ✅ |
| `amendment` | "ещё одном пострадавшем … за 7 сентября" — casualties learned today belonging to an **earlier** date. Additive; CIT adds to a figure rather than restating it | ✅ |
| `adjustment` | a signed correction CIT does **not** count in the day's headline | ❌ |

`adjustment` rows carry a `reason`:

- **`excluded_by_source`** — "из подсчёта были исключены два ребёнка", a
  retraction; negative.
- **`restated_by_source`** — "…составляет 87 человек, а не 90 как сообщалось
  ранее", the one form in which CIT revises a figure outright. Stored as
  `new − old`, usually negative. Left unhandled this reads as 87 + 90 = 177,
  which is the single worst failure mode in the archive.
- **`died_of_wounds`** — someone already counted as injured on date D has died.
  CIT adds +1 killed and leaves the injured count alone, so **we** emit the −1
  injured, outside the checksum, so a revised view can't count one person
  twice. This is the only figure in the DB that is ours rather than CIT's.

### Why retractions sit outside the checksum

Because the source puts them there. Post 12729, injured:

```
daily rows                                          88
+ amendments (Donetsk +1, Kherson +7, Belgorod +1)  +9
                                                   ---
                                                    97   ← the post says 97 ✓
- retraction (two children, Belgorod 28 Aug)        -2
                                                    95   ← not what the post says
```

Post 12526, killed: 18 daily + 1 amendment = **19** = stated, with the excluded
16 June death not deducted. Both posts agree: a retraction adjusts the running
tally, never that day's "стало известно" figure. So `sum_killed` / `sum_injured`
— and therefore `reconciled` — cover `daily` + `amendment` only.

## Dates on corrections

A correction names the date it belongs to, and `date_basis` says how firmly:

| `date_basis` | Meaning |
|---|---|
| `window` / `window_multiday` | a `daily` row, on the report's own window |
| `post_time` | 2023-era post with no window; date from the post timestamp |
| `explicit` | the clause names exactly one date |
| `split` | N casualties over exactly N dates → one row per date |
| `multi` | several dates, indivisible → `event_date` is NULL |
| `unknown` | no date found |

`multi` is common — **43% of correction clauses name more than one date**, and
often in counts that do not divide: *"ещё семи пострадавших в Херсонской
области за 26, 28 и 30 августа"* is seven people over three days. Splitting
that would be fabrication, so the row keeps the whole list in `event_dates`,
gets no `event_date`, and surfaces in the `corrections_unattributed` view
instead of landing on a chart.

## Views

| View | What it gives you |
|---|---|
| `daily_stated` | **the headline series** — CIT's own figure per report day, with `window_days` and `reconciled` |
| `daily_reported` | the region rows as first published, per day |
| `daily_revised` | what we now believe happened on each day, corrections folded back onto their own dates, with `source_post_count` / `source_post_ids` |
| `corrections_unattributed` | the `multi` / `unknown` clauses, so nothing is silently dropped |
| `reports_latest` / `casualties_latest` | the newest stored version of each post |

`daily_revised` is the "one row assembled from several posts" — derived, so it
can never go stale, and it names its sources:

```
event_date | killed | injured | source_post_count | source_post_ids
2026-09-07 |      8 |      78 |                 3 | 12844,12864,12886
```

Note that a revised **injured** figure can differ from anything CIT publishes,
because of the `died_of_wounds` −1. Killed and injured are separate series and
must never be summed into one "casualties" number — someone who was injured and
later died appears in both.

## The site

Site key `cit-civilians`, two pages, wired in `src/sites/registry.tsx`:

| Page | What it shows |
|---|---|
| `daily` | killed and injured per day, from `daily_stated`. Two charts, never one: the two series differ by roughly an order of magnitude and sharing an axis would flatten killed to nothing. |
| `monthly` | the same figures summed per month, plus two views of the regional breakdown and the caveat they share: casualties by controlling side, and the per-region table. |

The daily page also stacks the two into one "all casualties" chart
(`pairMode="sum"`), which is a good total and a poor split — killed is ~9% of a
day, so its band is unreadable at that scale and the blue band's top edge is
the total rather than injured. It sits above the two single-series charts
rather than replacing them.

The monthly page's **casualties by controlling side** chart sums killed and
injured and splits them Ukrainian-controlled vs Russian-controlled, the latter
being occupied Ukraine plus Russia proper — near-equal halves (13.5% and 12.7%
of the archive), so the tooltip breaks them out rather than letting one number
hide the other. Its colours are a categorical pair (`theme.categorical1/2`),
not the main/second series tokens: on a page where blue already means injured,
reusing it for a place would make one hue carry two meanings. They are also
deliberately not flag colours. The pair passes the lightness, chroma, CVD and
contrast checks against both surfaces, which is why one step serves both
themes.

The hook (`src/hooks/useDatabaseCitCivilians.ts`) reads the headline view for the
charts and `casualties_latest` for the region views. It spreads a weekend
report across its two days there — never in the DB — and tags both points with
a `note`, which `DailyLineChart` renders as a flagged dot plus the report's real
48-hour figures in the tooltip.

Production reads a stripped `cit-civilians.app.db` (raw post text and the
per-clause audit labels blanked, 11 MB → ~2 MB); dev reads the full DB, since
this is a whole fetch rather than a range fetch and the app copy would only add
a staleness trap. See the `VITE_CIT_DB_URL` note in CLAUDE.md.

## Storage model

Append-on-change, like `scripts/rubikon` and `scripts/sbu_alfa`: PRIMARY KEY
`(post_id, scraped_at)`. A post CIT later edits inserts a new versioned row
rather than overwriting; reads resolve the latest `scraped_at` per post via the
`*_latest` views. A re-scrape that parses identically inserts nothing.

`reports.body_text` keeps the stitched post text, so a parser fix can be
applied with `--reparse` instead of re-scraping. The split matters: a widened
scrape only recovers posts the parser **dropped**, while `--reparse` re-reads
posts already stored (CLAUDE.md).

## Format eras

The archive is not uniform. The channel starts 2023-09-02; daily summaries
start **2023-10-16** (post ~2105), and everything before that has no summary
format at all.

| From | Shape |
|---|---|
| 2023-10-16 → ~2023-11-06 | `Всего за прошедшие сутки:` — **no window, no total line**. `window_start` is NULL, `report_date` comes from the post timestamp, `reconciled` is NULL |
| ~2023-11 → ~mid-2025 | hyphen window; region lines are prose with city names inline and varied verbs (`получили ранения`, `были ранены`, `заявляется о N пострадавших`) |
| ~mid-2025 → present | en-dash window; regular `вследствие атак … погибли N человек, ещё M пострадали` |

The backfill covers all of it. Where the older prose defeats the breakdown the
post is stored with `reconciled = 0` and the headline intact, and `--reparse`
can improve those years later without re-scraping.

## Regions

Matched generically (any `<Adj>ой области`), not from a closed list, so a
region CIT reports for the first time still yields its casualties; the closed
lists only decide `country`, and an unknown region is warned about, never
dropped. Occupied and government-held parts of the same oblast are **separate
rows** — `на оккупированной территории Донецкой области` never collapses into
`в Донецкой области`.

Corrections often name only a city (`при атаках на г. Харьков 8 июля`). A
modest city→region map covers the ones CIT names repeatedly; anything else gets
`region_key='unknown'`, which costs the region attribution but never the
casualty count or its date.

## Gotchas the parser earns its keep on

- **`включая` / `в том числе`** introduce a sub-count of a figure already
  stated. Counting them double-counts.
- **A colon** after a count introduces a breakdown of it —
  `пострадали ещё 37 человек: полицейский, 13 газовиков и 23 спасателей` is 37
  people, not 73.
- **Word boundaries on numerals**: without them `восьмилетний` reads as 8 and
  `двухлетнюю` as 2.
- **`ещё` after a verb** binds a count to that verb
  (`и пострадал ещё 31 человек`) rather than starting a new tally; a comma is
  what distinguishes the two.
- **The window after a verb stops at a comma**: `20 человек погибли, 75
  получили ранения` has no `ещё` to split on, and without that bound the 75
  reads as the number of dead.
- **A trailing `… и мужчина`** has no verb of its own and continues the
  previous one. The test is a rejection filter, not a whitelist — CIT writes
  `лесник`, `начальник пожарной части`, `спасатель ГСЧС` — plus a
  capitalisation check, because `при обстрелах Токаревки, Молодежного и
  Зеленовки` is a list of villages, not of victims.
- **Typos**: `пострадли`, `ешё`, zero-width characters mid-word, and a region
  in the nominative (`в Сумская области`) all appear in the archive.
