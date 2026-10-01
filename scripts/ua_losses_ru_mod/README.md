# UA losses claimed by the RU MoD — John Felix's sheet

Builds **`ua-losses-ru-mod-john-felix.db`** — the **UA LOSSES - RU MoD** view
(site `ua-losses-ru-mod-john-felix`) — from John Felix's
([@NedSnow2019](https://x.com/NedSnow2019)) hand-compiled
[Google Sheet](https://docs.google.com/spreadsheets/d/1U1kZiRglakIO_rfyYaR2cNaD2DUNCGKWv60iDPspgFs)
of the Ukrainian losses the Russian MoD claims, first tab, via its public CSV
export. stdlib only.

## Local only

The sheet carries no licence, and the maintainer hasn't answered yet. Until he
does, nothing here is published: no CI workflow, no R2 object, no
`VITE_UA_LOSSES_RU_MOD_DB_URL` in `.env.production`, and the site is listed
only in dev builds (`localOnly` in `SITES`, `src/types/index.ts`) — as are its
metrics in the homepage's combined charts (`UA_LOSSES_RU_MOD_METRICS`,
`src/utils/combinedMetrics.ts`). Publishing it later means adding those three
things and dropping both dev-only gates.

```sh
python3 scripts/ua_losses_ru_mod/ingest.py --out data/ua-losses-ru-mod-john-felix.db
python3 scripts/ua_losses_ru_mod/ingest.py --csv sheet.csv --out …   # from a saved export
```

## What the sheet is

One row per MoD report day from 24/02/2022, ~290 columns. Row 6 is the header;
the rows above it are Felix's notes and grand totals, and the sheet keeps a
couple of weeks of empty rows ready below today (a row counts only once its
armour total is filled in — the empty ones' formula columns already read as the
whole war's losses in reverse).

The columns fall into blocks, each opened by an anchor header:

| Block | Anchor column | Then |
|---|---|---|
| armour, artillery, MLRS, air defence, aircraft, helicopters, UAVs, special vehicles | the **MoD's running total** — its own "since the start" figure | a "(Daily)" diff column (not stored), then Felix's itemisation by model |
| personnel | killed + wounded, **daily** | a weekly sum (not stored) |
| captured | daily | |
| intercepted munitions, radars, EW stations | — (the MoD never totals these) | itemised by model |

Every weekly column is the Saturday–Friday sum of the daily ones, and the
weekly field-gun / mortar split adds up to the week's artillery, so none of
them are stored.

### The totals are the MoD's, the items are Felix's

The items do **not** reliably sum to the MoD's figure. Felix itemises the
report text, and that itemisation is incomplete before 2025 (armour 2022:
3,368 itemised of 7,349; artillery 2022: 207 of 3,754 — complete from 2023;
row 4 of the sheet says "WIP (lacking about 10k tanks and other AVs)"), and on
some days overshoots (07/03/2025: MoD +78, items 80). So the headline series is
the MoD's running total, diffed, and the items are a breakdown of it — on the
site, a tooltip with a signed "Not itemised" remainder.

UAVs are not itemised at all: "LR OWA UAVs" is a *subset* of the MoD's UAV
figure (long-range one-way attack drones), stored as role `sub`, never added.

Early-2022 personnel figures are occasional MoD statements rather than daily
claims (24/02: 8,745; 02/03: 2,870 — then nothing until the daily per-group
claims start).

### Columns position would misfile

Header text, not position, identifies a column — Felix inserts a model column
wherever new kit turns up — and the block is whichever anchor precedes it. A few
need an override (`OVERRIDES`):

- "Mortars (and Friday's unspecified artillery)" sits just before the artillery
  anchor but is artillery.
- 2025's weekly NATO / Soviet artillery split — dropped (weekly). "Soviet" under
  MLRS is a model and is kept: a header is identified within its block.
- "Mortars (82mm/120mm)" (2022–24) is a subset of the mortar column above.
- "Tochka-U Launcher" sits among the munitions it fires.

### Intercepted munitions, by kind

What the MoD claims its air defence shot down — Ukrainian fire, not Ukrainian
losses. `MUNITION_GROUPS` files each column under cruise / ballistic /
mlrs_rockets / guided_bombs / air_launched, because the MoD's naming drifts
(it stopped naming JDAM / Hammer around 06/2025 and says "guided aerial bomb"
since), so a model's series starts and stops where its group's carries on.
S-200 (fired at ground targets — neither cruise nor ballistic), "Patriot"
(likely interceptors) and jet drones are stored in no group. A new munitions
column not in the map is stored and flagged as a notice, so it gets classified.

A new model column inside a known block is picked up as an item. A missing
anchor aborts the run rather than filing whole blocks under the wrong category.

## Storage

Append-only, long format, versioned per cell:

- `items(id, section, item, label, role, subgroup, first_seen)` — one per
  stored column. `role`: `total` (MoD running total) | `daily` | `item` |
  `sub`. `subgroup` (armour only): tanks / ifv / apc / acv / other, from the
  "Unknown …" column opening each run of models.
- `claims(report_date, item_id, snapshot, value)` — one row per non-blank cell
  version. A corrected cell gets a new row under a newer snapshot; a cleared one
  a `NULL`. Integer keys: it is ~35k rows and the browser downloads the file.
- `snapshots(id, scraped_at)`, `notes(report_date, snapshot, text)` — Felix's
  daily summary of the report, kept as the raw text behind the numbers.
- View `latest_claims` — the latest non-null version of every cell.
- View **`daily`** — one row per report day: the eight running totals diffed
  (in long format, so a day missing one total doesn't dump the war-to-date into
  the next day's diff), personnel, captured, the armour subgroup sums, and
  `uav_lr_owa`, `radars` / `ew` and `intercepted_<group>` — the sum of those
  blocks' items, since the MoD keeps no total for any of them (a day without one is 0, not unknown). The
  MoD doesn't fold radars into its air-defence total either: on 118 of 128 days
  with an S-300/Patriot/NASAMS radar claimed, the air-defence figure is the
  launchers alone. A correction passes through as that day's value (05/04/2025:
  armour −6, vehicles −11).

Guards: fewer than 365 days, or fewer days than already stored, aborts without
writing.

## Dates

`report_date` is the date the sheet gives the row — the day the MoD published
the claims. Those cover the 24 hours to that morning: the sheet's long-range UAV
figure equals the MoD's own daytime drone claim of D−1 plus its overnight claim
into D (from the `ru-mod-ad` DB, which keeps each claim's window) **exactly** on
227 of 1,003 days in 2024–26, against 23 for D's overnight alone and 46 for D's
overnight + daytime.

So the `daily` view is keyed by **`loss_date` = report day − 1**, with the
report date kept alongside. That is also how the GSUA losses series is dated
(the General Staff's morning report covers the 24 hours before it), so the two
line up in the combined charts. The exception is the war's start: the MoD
briefed through 24/02/2022 about that same day, so the first two reports (24th
and 25th) both land on 24/02 — as GSUA's series starts too. Days are Moscow's.

## Tests

`bash scripts/test_python.sh scripts/ua_losses_ru_mod` — header mapping,
parsing and the `daily` view, on a synthetic miniature of the sheet.
