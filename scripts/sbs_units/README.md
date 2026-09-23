# SBS sub-units ingest

Snapshots each sub-unit of the Unmanned Systems Forces from the public
`sbs-group.army` API into `data/sbs-units.db`.

The grouping total (Угруповання СБС) is **not** here — `scripts/fetch_and_update.py`
tracks it into `sbs.db`. The split is deliberate: `sbs.db` is fetched whole by
every SBS page including the hourly one, and unit data is only read by the
monthly / compare / combined views.

```sh
python3 scripts/sbs_units/discover.py          # what the API currently exposes
python3 scripts/sbs_units/ingest.py            # current buckets
python3 scripts/sbs_units/ingest.py --all      # backfill everything reachable
python3 scripts/sbs_units/check_db.py          # whole-table checks
pytest -q scripts/sbs_units/test_ingest.py
```

## What the API gives you

Statistics are addressable **only** as `/statistics/{subdivisionId}/{periodId}`.
There is no date-range query — `?startDate=`, `?from=`, and a bare subdivision
id all 404. So every run rediscovers both halves from `/subdivisions` and
`/periods`, and nothing downstream works from an id anyone wrote down.

Both listings paginate and default to **50 of ~245** entries, across every
subdivision at once. Ask for `?limit=500`; `discover.py` warns if the
pagination block says there was more, because a short page is indistinguishable
from a unit or a month not existing.

### The twelve-slot window — why the backfill was a one-shot

Each subdivision gets a fixed set of twelve `monthly_N` period slots, **and
they are re-pointed every year**. Today's `monthly_8` is August 2026 for a live
unit — and August *2025* for Flying Skull, because a retired unit's slots stay
frozen on its own last months.

Two consequences, both load-bearing:

1. **A period id is not a name for a calendar month.** Everything here keys on
   the `startDate` the payload itself states, and `read_period` refuses a
   payload whose stated month isn't the one it is about to be filed under.
   This is not theoretical: the hardcoded fallback map that used to live in
   `fetch_and_update.py` had an id filed under "2025-06" that now serves **June
   2026**.
2. **Months older than the window are gone.** When this was first backfilled
   (2026-09) the live units reached back only to 2025-10. Anything earlier is
   unreachable for them, forever. `check_db.py` shouts about an uncaptured
   month for exactly this reason — it is the one failure here that cannot be
   repaired later.

The `yearly_*` periods are stored for the same reason: a year total is the only
figure that survives for a month that has already rolled out. They are
ingested but deliberately **not surfaced** in the UI — the spans are not
comparable across units (a unit that formed in June still reports its 2025
period as "2025").

### `status` is the only thing separating data from nothing

An unrecognised `(subdivision, period)` pair returns **HTTP 200** with
`status: "not_collected"` and every counter zeroed. And 194 ОПМБр genuinely
reported **0** across 2026-08. So zero is not a sentinel in this API; only
`status == "completed"` distinguishes the two, and the ingest gates on it
everywhere.

### Retirement is derived, never listed

Nothing in the API flags a retired unit — the periods simply stop being issued.
A unit is treated as retired when it no longer has a live `daily` period, which
is currently **Flying Skull** (2025-06…2025-12) and **91 ОПТБ**
(2026-02…2026-04). Deriving it means the next retirement needs no code change,
and `upsert_units` warns on the transition.

**1 ОЦ БПС is skipped**: it exposes no monthly periods at all, and its `daily`
endpoint has been frozen on `2025-08-30` with zeros for over a year. The rule
is "no monthly periods, nothing to store" rather than a name-based exclusion,
so it starts being tracked on its own if the source ever publishes one.

### The units do not sum to the grouping

Targets Hit, named units vs the USF total: 2026-08 → 57,268 vs 57,482; 2026-07
→ 53,553 vs 53,755; 2026-02 → 27,216 vs 27,332. A stable **~0.4% residual**.
Do not present the units as a decomposition of the total without an explicit
unattributed band.

## Storage model

Append-on-change, as everywhere in this repo, plus a second brake: a **capture
bucket** in the primary key.

| table | bucket | grain |
|---|---|---|
| `unit_daily_stats` | the Kyiv **day** | one calendar day |
| `unit_monthly_stats` | the Monday of the Kyiv **ISO week** | one calendar month |
| `unit_yearly_stats` | the Monday of the Kyiv **ISO week** | one calendar year |

Kyiv rather than UTC so the bucket boundary lines up with the one the data
uses. Under UTC, a run between 21:00 and midnight UTC — where Kyiv is already
tomorrow — would file tomorrow's provisional row under today's bucket.

A run whose bucket row already exists **updates it in place**. That decouples
row count from run frequency: both of the workflow's twice-daily runs land in
one bucket, so the second improves freshness without costing a row. `sbs.db`'s
`monthly_stats` behaves the opposite way — its key carries `data_collected_at`,
so more runs mean more rows, which is why it holds ~120 rows per month.

The bucket is a **cap, not a sample**: the current month's row is refreshed on
every run, so the value the site shows is never more than one run old. What a
weekly bucket gives up is the intra-month *curve*, and `unit_daily_stats`
already carries that at better resolution.

A month then collects ~5 in-month rows plus ~2 during its 10-day revision tail
(where the source's corrections actually land), instead of ~30. Append-on-change
sits on top, so a frozen unit writes nothing at all once captured.

Each date ends up with **two** daily rows: the provisional reading captured
during the day itself, and the settled value from the next day's `prev_day`
call. Reads resolve `MAX(capture_bucket)`.

### Don't derive monthly from daily

Tempting, since daily gives per-day values — but they disagree. Summing the
USF's day-final values against its own published month:

| month | published | Σ daily |
|---|---|---|
| 2026-05 | 44,138 | 45,333 |
| **2026-06** | 50,147 | **50,147** |
| **2026-07** | 53,755 | **53,756** |
| 2026-08 | 57,482 | 58,493 |

Two months reconcile exactly, so the definitions match — the gap elsewhere is
**late revisions**. The source revises a day more than once; `prev_day` only
ever looks one day back, so a daily series freezes at the first revision while
the monthly endpoint keeps absorbing later ones. The error is always *high*:
days get revised **down** afterwards.

For units this is structurally worse — `daily` and `prev_day` are the only
intraday periods that exist, so one day back is a hard ceiling. A unit's daily
row can never absorb a later revision; its monthly row self-heals every run.
**Monthly is authoritative. Daily is a shape with a known ~1–2.5% high bias.**

And daily has **no backfill at all** — only today and yesterday are
addressable, so the series starts the day the job is switched on and can never
be filled in behind.

## Cadence

`update-sbs-units-db.yml` runs at **09:00 and 21:00 Kyiv**. Its own workflow
rather than a job on `update-db.yml`, because that one is triggered externally
about once an hour and this ingest has no use for that — ~60 requests to change
freshness, not rows.

21:00 is the useful run: `prev_day` has had ~21h to settle and "today" is ~87%
complete for the provisional row, far enough from midnight that GitHub's
scheduler lag can't push it past the rollover.

09:00 is redundancy, and that is the point of running twice. A day's settled
value is reachable only while it is `prev_day` — during the following day — so
if both of a day's runs are skipped, that day's settled row is gone for good.
The day still lands in the monthly totals, which are re-read independently; it
is the daily row that is lost.

## Don't repeat these mistakes

- **Addressing a month by its slot name.** `monthly_8` is whatever August that
  subdivision is currently pointed at. Always read the payload's `startDate`.
- **Treating zero as missing.** Real units report zero months. `status` is the
  test.
- **Writing a `not_collected` payload.** It is HTTP 200 with a full-looking
  body; nothing errors, you just get a month of invented zeros.
- **Warning about "new" target ids on an empty table.** `ensure_columns` only
  warns once a table already has target columns — otherwise a fresh backfill
  reports all 43 ids as new and trains people to ignore the panel.
- **Deriving a row's date from the clock.** The daily endpoints state which day
  they cover; a lagging endpoint would otherwise be filed against the wrong day.
- **Alarming on a closed month that moved.** Closed months drift by single
  digits in *both* directions as a matter of course (the USF's 2026-01 fell by
  3, its 2026-04 rose by 4). `check_db.py` only reports moves of ≥1%.
