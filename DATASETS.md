# Candidate datasets for new views

Research compiled 2026-05-25. Recency verified via GitHub `pushed_at` / Kaggle versions
/ live API responses on that date. We already ingest: SBS (direct API) and GSUA per-direction
combat stats (scraped → R2 → sql.js-httpvfs).

Legend: **LIVE** = updated within the last few days · **STALE** = not updated · **GAP** = no
off-the-shelf dataset, would need our own scraper.

---

## 1. National GSUA totals (personnel & equipment losses)

### russian-casualties.in.ua — LIVE — ✅ INTEGRATED (site "ru-losses-gsua")
Pipeline: scripts/ru_losses/ingest.py → ru-losses-gsua.db → R2 (workflow
update-ru-losses-db.yml; workflow downloads current DB first, so it appends).
Frontend: snapshot-only, no API fallback; tiny DB fetched whole via sql.js
(useDatabaseRuLosses). Views: Daily + Monthly.
Storage model: APPEND-ONLY, like the GSUA `posts` table. `daily_losses` keyed by
(date, snapshot_at); each run inserts a new row only when a date's values differ
from the latest stored version (or it's a new date). Nothing is ever overwritten,
so corrections are captured as fresh rows and bad values can't clobber good data.
Build aborts (skipping upload) if the fetch is < 365 days or has fewer dates than
already stored. Frontend reads the latest snapshot per date.
- URL: https://russian-casualties.in.ua/ · docs: https://russian-casualties.in.ua/docs/export
- Endpoints (JSON + CSV, three granularities):
  - `https://russian-casualties.in.ua/api/v1/data/json/daily` (also `weekly`, `monthly`)
  - `https://russian-casualties.in.ua/api/v1/data/csv/daily` (also `weekly`, `monthly`)
- Tracks: personnel, captive, tanks, apv, artillery, mlrs, aaws, aircraft, helicopters, uav,
  vehicles, boats, submarines, se (special equipment), missiles. Includes a `legend` map.
- **Already DAILY increments** (not cumulative) — no diffing needed. Keyed by date
  (`"2026.05.24": {personnel:1020, uav:1924, ...}`).
- Recency: live through previous day (2026-05-24 at time of research).
- **CORS: `access-control-allow-origin: *`** → can fetch directly from the browser, no R2 needed.
  `cache-control: no-cache` (no CDN caching) → snapshot in CI if we want resilience.
- Source: Ukrainian General Staff. License: none stated.
- Parse difficulty: trivial. Monthly endpoint maps onto our existing GSUA monthly aggregation.

### piterfm / PetroIvaniuk — LIVE — fallback
- https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset · MIT-ish (no explicit license)
- Cumulative JSON (`russia_losses_personnel.json`, `russia_losses_equipment.json`, plus an
  Oryx-derived file + correction files). Daily = trivial diff. Pushed daily.
- De-facto upstream standard (CSIS / ISIS build on it).

### lod-db/orc-losses — LIVE — fallback
- https://github.com/lod-db/orc-losses · MIT · pushed daily
- Clean daily `russian-losses.json` with a real JSON schema. Source: Ukrainian MoD (same as above).
- Pick ONE of these three for national totals — all share the same Ukrainian-govt upstream.

---

## 2. Ukrainian air defense — Russian aerial attacks launched vs intercepted (TOP INTEREST)

### piterfm "Massive Missile Attacks on Ukraine" (Kaggle) — LIVE — RECOMMENDED
- https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine
- The only good machine-readable option. Solves the image-extraction problem (already digitized
  from the Air Force's posts).
- Long-format CSV: one row per weapon model per attack with `launched` / `destroyed`, broken down
  by type (Shahed-136/131, Kh-101, Kalibr, Iskander, Kinzhal, S-300/400, etc.).
  Files: `missile_attacks_daily.csv` (~21 cols) + `missile_and_uav.csv` (weapon reference).
- Since Oct 2022, still actively versioned (~v116+). License: attribution-required.
- Parse: easy — pivot by date + model. Closest in spirit to our existing SBS/GSUA work.

### Stale / not machine-readable
- CSIS Russian Firepower Strike Tracker — STALE (only through 2024-11-30); just re-publishes piterfm.
- ISIS Shahed analysis — current but PDF only (cross-validation, not ingestion).
- Airwars Shahed Map — DEAD (through 2023-08-30).

---

## 3. Official Russian sources (Ukrainian losses + drones shot down over Russia) — GAP

- **No digitized dataset exists.** Russian MoD (Минобороны) daily claims live only as press text
  (RT / Pravda / their Telegram). Would require our own scraper of mil.ru or their Telegram —
  same pattern as the GSUA scraper. Flagged as a genuine gap.

---

## 4. Ukrainian strikes INTO Russia (drones launched at Russian territory)

### unmannedsystemstracker.com — LIVE
- https://unmannedsystemstracker.com/ — updated through April 2026.
- Tracks both directions: Ukrainian long-range drone strikes into Russia (refineries, air defense)
  + Russian strikes on Ukraine. In-browser CSV export (USV strike log, UAV kill board, air defense
  log) + GitHub backing. No stable API — scrape the export endpoints. No stated license.

### Baker Institute — Ukraine strikes on Russian energy infrastructure — periodic
- bakerinstitute.org — ~272 strike events, Apr 2022–Feb 2026. Likely Excel/CSV on request.
  WebFetch blocked (403). Not confirmed live past Feb 2026.

---

## 5. OSINT / independent of either government

### leedrake5/Russia-Ukraine — LIVE — best OSINT equipment source
- https://github.com/leedrake5/Russia-Ukraine · MIT · pushed daily
- Oryx visually-confirmed equipment losses, machine-readable CSV mirror
  (`data/bySystem`, `byType`, FIRMS, Naalsio). Easy parse. Good counterweight to govt claims.

### UALosses — LIVE — best Ukrainian-casualty source
- https://ualosses.org/ + Kaggle `ol4ubert/confirmed-ukrainian-military-personnel-losses`
- Named, confirmed Ukrainian KIA from obituaries/OSINT. Updated weekly (~91.5k as of Apr 2026).
  Validated by Mediazona/BBC. Kaggle CSV, easy parse.

### zhukovyuri/VIINA — LIVE
- https://github.com/zhukovyuri/VIINA · ODbL · pushed daily
- Geocoded violent-incident events from both sides' news, ML-classified. CSV. Medium parse.
  Good for event/geo data incl. strikes inside Russia.

### ACLED — LIVE but license-restricted
- acleddata.com / HDX `ukraine-acled-conflict-data`. API + CSV, weekly. Free tier aggregated only;
  disaggregated/real-time needs paid tier. Medium parse.

### Index (not a primary source)
- simonhuwiler/russo-ukrainian-data-ressources — useful link index, no license.

### Stale / avoid
- alexdrk14/RussoUkrainianWar_Dataset (last push 2024-07)
- CulleyHarrelson/RussiaUkraineWarEquipmentLosses (last push 2024-09)

---

## 6. Front-line weather (precipitation / temperature mapped to directions)

Idea: weather affects combat ops (precipitation, low temp, mud). No existing dataset maps weather
to the war's directions — but we can build it by mapping each GSUA direction to coordinates and
pulling a historical weather archive.

### Open-Meteo historical archive — LIVE — RECOMMENDED
- Archive (ERA5 reanalysis): `https://archive-api.open-meteo.com/v1/archive`
  - e.g. `?latitude=48.28&longitude=37.18&start_date=2026-05-18&end_date=2026-05-20&daily=temperature_2m_mean,precipitation_sum,rain_sum,snowfall_sum,wind_speed_10m_max&timezone=Europe/Kyiv`
- Returns daily (or hourly) temperature, precipitation, rain, snowfall, wind, etc. with units.
- Free, **no API key**, **CORS open** (`access-control-allow-origin: *`) → direct browser fetch
  works, same as russian-casualties.in.ua. Free tier is non-commercial, <10k calls/day (tiny for us).
- Parse: trivial — arrays aligned on a `time` (date) array; align on `date` with GSUA daily rows.

Approach:
- Static **direction → representative lat/lon** lookup (~15-20 rows, namesake town: Pokrovsk
  48.28/37.18, Kupyansk, Lyman, Kursk, etc.), curated once. Overlay precip/temp vs attack counts.
- Snapshot in the existing GitHub Action (1 call per direction per day) for resilience + to avoid
  hammering the free tier; direct browser fetch is the fallback.

Tradeoffs:
- A direction is a front line, not a point — single-town point is a fine approximation for
  temp/precip (regionally coherent ~50 km); averaging 2-3 points possible but likely overkill.
- Archive (ERA5) lags ~5 days. Recent days need the forecast endpoint
  (`api.open-meteo.com/v1/forecast?...&past_days=N`) to fill the gap.

---

## Suggested integration order

1. **russian-casualties.in.ua** — national GSUA totals. Lowest effort: pre-differenced daily
   values + open CORS = direct browser fetch, no scraper/R2. New site-picker entry.
2. **piterfm "Massive Missile Attacks"** — air defense launched-vs-intercepted. High value,
   closest to existing SBS/GSUA work. Needs a small ingest (Kaggle CSV → our DB/R2).
3. **leedrake5 Oryx** — OSINT-verified equipment as a counterweight to government claims.

Open question / gap: Russian MoD daily claims (category 3) would need a dedicated scraper.
