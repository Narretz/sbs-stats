# Candidate datasets for new views

Research compiled 2026-05-25. Recency verified via GitHub `pushed_at` / Kaggle versions
/ live API responses on that date. We already ingest: SBS (direct API) and GSUA per-direction
combat stats (scraped → R2 → sql.js-httpvfs).

Legend: **LIVE** = updated within the last few days · **STALE** = not updated · **GAP** = no
off-the-shelf dataset, would need our own scraper.

---

## 1. National GSUA totals (personnel & equipment losses)

### PetroIvaniuk/2022-Ukraine-Russia-War-Dataset — LIVE — ✅ INTEGRATED (site "ru-losses-gsua")
Pipeline: scripts/ru_losses/ingest.py → ru-losses-gsua-petroivaniuk.db → R2 (workflow
update-ru-losses-db.yml; workflow downloads current DB first, so it appends).
Frontend: snapshot-only, no API fallback; tiny DB fetched whole via sql.js
(useDatabaseRuLosses). Views: Daily + Monthly.
Storage model: APPEND-ONLY, like the GSUA `posts` table. `daily_losses` keyed by
(date, scraped_at); each run inserts a new row only when a date's values differ
from the latest stored version (or it's a new date). Build aborts (skipping
upload) if < 365 days parsed or fewer dates than already stored.
- Repo: https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset · MIT · pushed daily.
- No REST API — fetch two raw JSON files: `data/russia_losses_equipment.json` +
  `data/russia_losses_personnel.json` (plus an Oryx-derived file + a documentary
  correction file we do NOT apply). De-facto upstream standard (CSIS/ISW build on it).
- **CUMULATIVE** war-to-date totals, one record/day → we diff consecutive days to per-day
  increments. Corrections are already baked into the totals (they decrease on correction
  dates), so diffing passes them through; the correction JSON is documentary only.
- Tracks (mapped → our keys): personnel, tank→tanks, APC→apv, field artillery→artillery,
  MRL→mlrs, anti-aircraft warfare→aaws, aircraft, helicopter→helicopters, drone→uav,
  vehicles and fuel tanks→vehicles, naval ship→boats, special equipment→se,
  cruise missiles→missiles, **ground robotic systems→ugs** (the reason for the switch,
  cumulative from 2026-05-03), POW→captive (data only through 2022-04-27 — GS stopped
  reporting POWs). Ignored: submarines (flat-zero), greatest losses direction (text),
  early-war military auto / fuel tank / mobile SRBM system.
- Date model: store `date` = loss day (report day − 1, matches old source) +
  `reported_at` = GS report day. `check_drift` flags any unmapped source key in CI.

> **Switched from russian-casualties.in.ua (2026-05).** That source never added the GS's
> new unmanned-ground-systems category and is an anonymous site with no contact / no CDN
> caching. PetroIvaniuk carries `ugs`, is a named MIT repo with 4y of history, and is a
> strict superset of the columns we tracked. Cost of the switch: it's cumulative (we diff)
> and labels dates one day later (we shift −1). Validated: 1517/1552 days identical to the
> old source. **lod-db/orc-losses** (https://github.com/lod-db/orc-losses, MIT) remains a
> clean daily-JSON fallback, but lacks the UGS column.

---

## 2. Ukrainian air defense — Russian aerial attacks launched vs intercepted (TOP INTEREST)

### piterfm "Massive Missile Attacks on Ukraine" (Kaggle) — LIVE — ✅ BACKEND INTEGRATED
- https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine
- The only good machine-readable option. Solves the image-extraction problem (already digitized
  from the Air Force's posts).
- Long-format CSV: one row per weapon model per attack with `launched` / `destroyed`, broken down
  by type (Shahed-136/131, Kh-101, Kalibr, Iskander, Kinzhal, S-300/400, etc.).
  Files: `missile_attacks_daily.csv` (~21 cols) + `missile_and_uav.csv` (weapon reference).
- Since Oct 2022, still actively versioned (~v116+). License: attribution-required (credit
  piterfm / UA Air Force on the view).
- Parse: easy — pivot by date + model. Closest in spirit to our existing SBS/GSUA work.
- **Pipeline:** scripts/missile_attacks/ingest.py → ru-air-attacks-gsua.db → R2
  (workflow update-missile-attacks-db.yml; downloads current DB first, so it appends).
  Named as the Ukrainian-side mirror of ru-mod-ad.db (ru-mod-ad = UA launches at RU + RU
  intercepts; ru-air-attacks-gsua = RU launches at UA + UA intercepts). Frontend: TODO (site wiring
  not yet done). DB is small → fetch whole via sql.js.
- **Data access:** Kaggle-ONLY — no GitHub mirror (piterfm's GitHub dataset repo holds only the
  losses JSON; his dashboard repo is stale since 2024-11). The Kaggle API gates downloads behind a
  FREE account token: ingest.py pulls the dataset zip over HTTP Basic auth using the KAGGLE_USERNAME
  / KAGGLE_KEY secrets (the two fields from kaggle.json). `--csv <path>` ingests a local file for
  testing without credentials.
- **Storage model:** APPEND-ONLY & versioned-on-edit (like ru_mod/ru_losses). Each row is one
  report line, keyed by (time_start, time_end, model, launch_place, target, source, scraped_at).
  `source` (the originating UA Air Force / regional-command post) is the disambiguator — same-day
  reports of the same model+target from different commands differ only by source; without it the
  natural key collides (verified against the live 3728-row file: 6 colliding keys → 0 once source
  is added). NB the `model` column can BUNDLE types (e.g. "X-101/X-555 and Kalibr and Iskander-K"),
  so daily_by_model groups by the bundled string; a true per-type breakdown would need to split on
  " and " in the query layer.
  piterfm edits historical rows in place across whole-file Kaggle versions, so each run re-downloads
  the latest CSV and inserts a NEW row tagged `scraped_at` only when a value changed (or the key is
  new). Nothing is overwritten; frontend reads the latest scraped_at per key. We use `scraped_at`,
  NOT `snapshot_at` (which in the GSUA schema means the source's own "as of" timestamp).
  Grain stays as-is; the filename says "daily" but it is NOT a daily aggregate — daily volume is
  aggregated in the query layer (`daily_totals` / `daily_by_model` views, GROUP BY date(time_start),
  so a cross-midnight overnight strike counts to its start date). Build aborts (skipping upload) on a
  row-count floor (1000), a shrinking key set, or CSV header drift.

### Stale / not machine-readable
- CSIS Russian Firepower Strike Tracker — STALE (only through 2024-11-30); just re-publishes piterfm.
- ISIS Shahed analysis — current but PDF only (cross-validation, not ingestion).
- Airwars Shahed Map — DEAD (through 2023-08-30).

---

## 3. Official Russian sources (Ukrainian losses + drones shot down over Russia) — GAP

The Russian MoD (Минобороны России) DOES post centrally — on mil.ru and its Telegram channel
("Минобороны России") — in two streams (confirmed 2026-05):
1. **Daily "Сводка" (SVO summary):** cumulative-since-2022 claims of destroyed Ukrainian materiel,
   including a running **UAV count** ("беспилотных летательных аппаратов"). Mirror of the GSUA losses
   report we ingest (RU LOSSES site).
2. **Air-defense intercept reports:** posted several times/day during attacks — "за минувшую ночь
   средствами ПВО перехвачено и уничтожено N украинских БПЛА," often with a **regional breakdown**
   (Moscow Obl., Bryansk, Kursk, …). RIA Novosti relays these into weekly tallies.

- **Still a GAP for ingestion — no digitized RU-MoD dataset found** (checked 2026-05). Every
  machine-readable "drones" dataset out there is UKRAINIAN-side (piterfm "Massive Missile Attacks" =
  what Russia *launched*, per UA Air Force — see §2), not a parse of the RU MoD's own claims.
- To use it we'd build our own scraper of mil.ru / the MoD Telegram, **same pattern as the GSUA
  scraper** — parse prose for (1) the daily cumulative UAV-destroyed number and (2) the air-defense
  intercept counts + regions.
- **Caveats:** claims are unverified (widely considered inflated); stream 2 counts drones
  **downed/intercepted**, a floor for drones *launched at Russia*, not the launch count itself.

### Status of what's IMPLEMENTED (scripts/ru_mod → ru-mod-ad.db, RU AIR DEFENSE - MoD site)
- We scrape stream 2 (air-defense intercepts) from @mod_russia via the t.me/s web preview (no API)
  with a telethon backfill option. Per-day totals + overnight/daytime split are charted.
- **Per-region counts:** the MoD format *changed over time*. In 2025 some night reports itemized
  per region ("42 – над территорией Саратовской области, 12 – над Ростовской, …", summing to the
  total); through 2026 they give only a total + a flat region list. The parser captures the itemized
  pairs into `ad_regions` when present, but all currently-scraped 2026 posts are total-only, so that
  table is empty until a telethon backfill into 2025. A per-region view should wait on that.
- **Window overlaps (possible double-count):** occasionally the MoD posts an evening update (e.g.
  "с 20.00 до 23.00 мск") *and* a separate overnight report that states no start time — we assume
  20:00, so the two windows overlap and the overnight count may re-include the evening's drones. We
  don't guess a different start; the build flags the later report in `ad_reports.notes` and warns.
  These sit on adjacent `report_date`s, so a single day's total isn't inflated; the open question is
  only whether the MoD itself re-counts across the two posts (unknowable from the text). The flag is
  recomputed from the latest version each run, so it never goes stale. As of the Jan–May 2026
  backfill: 3 such cases, all February.

### Ukrainian-LOSSES reporting by the MoD — degraded, REVISIT (noted 2026-05)
The MoD's cumulative Ukrainian-loss reporting has *thinned out over time*:
- **2025:** weekly "Сводка … о ходе проведения СВО **с DD month по DD month YYYY**" posts carried
  cumulative **equipment** losses (tanks, aircraft, UAVs, …) — but **no personnel** figures.
- **2026:** the cumulative-**loss** Сводки appear to be gone. Сводка posts still show up, but the ones
  our 2026 scrape captured are **operational/ceasefire narratives**, not loss tables — e.g. the
  8–11 May 2026 Victory-Day truce produced daily ("по состоянию на DD мая") and weekly ("со 2 по 8
  мая") Сводки reporting *truce-violation* counts, with no cumulative equipment/personnel totals.
  They're also **multi-part** (the same header repeats across [1/n] message parts).
- We now **store every Сводka post raw** in a `summaries` table (post_id, posted_at, kind ∈
  {svodka_weekly, svodka_daily, svodka}, parsed header period, full text) **without parsing numbers**,
  so the source is retained whatever the format does next.
- **REVISIT:** (a) telethon-backfill 2025 to recover the weekly equipment Сводки; (b) parse cumulative
  equipment from those; (c) pin down exactly when personnel reporting stopped (looks pre-2025 already);
  (d) compare equipment trend against the GSUA RU-LOSSES series. Deep history needs the telethon backend.

---

## 4. Ukrainian strikes INTO Russia (drones launched at Russian territory)

### unmannedsystemstracker.com — reference only (NOT for ingestion)
- https://unmannedsystemstracker.com/ — updated through April 2026.
- Tracks USV strikes (vs Black Sea Fleet), UGV ops, UAV strikes (claims 822k+ w/ casualty figures),
  plus air-defence interceptions, Oryx equipment losses, territorial advances, and deep-strike logs
  (UA→RU refineries/air defense + RU→UA). In-browser CSV export per table; no stable API.
- Verdict (checked 2026-05): an AGGREGATOR, not a primary source. Inputs are sources we already
  catalogue — piterfm/PetroIvaniuk air defense, Oryx (via leedrake5), Mediazona/BBC named-KIA, ISW/CSIS.
  Updates ~quarterly (not daily), CSV is generated client-side (fragile to scrape), no stated license.
  Poor fit for our daily CI→R2→SQLite snapshot pattern. Keep as a human cross-check only; if we ever add
  a drone/naval-strike view, ingest the UPSTREAM repos (piterfm for air defense, leedrake5/Oryx for
  losses) rather than scraping this site. The only genuinely distinct content here is the USV/UGV/
  deep-strike logs, which have no machine-readable upstream + only quarterly freshness.

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

## 7. Russian recruitment & budget-derived casualties (Janis Kluge / Russianomics) — GAP

### janiskluge.substack.com ("Russianomics") — LIVE (content) but NOT machine-readable
- https://janiskluge.substack.com/ — Janis Kluge (SWP). Tracks Russian **recruitment**
  (~800–1,000 contracts/day in early 2026, falling) and **personnel losses** (~250–300
  KIA/day), plus defense spending. Distinctive because it's derived from *Russian* budget
  data, not Ukrainian claims or OSINT obituaries — an independent third estimate.
- **Methodology (his, originally from iStories):** Russian regional + federal budget
  *execution* reports give (a) total signing-bonus outlays → ÷ per-recruit bonus =
  recruit count; (b) family death-compensation payouts → KIA count. Sample = ~40 regions
  (~47% of population), scaled to a national figure.
- **The catch — only charts, and they're flat PNGs.** Every figure is published as a
  static `substackcdn.com/image/fetch/...` PNG (verified 2026-05); there is **no backing
  dataset, CSV, or chart embed** (not Datawrapper/Flourish/Highcharts) to read. His
  separate budget browser (http://budget.jakluge.de, federal budget 2018–2025) is a JS
  viz with **no export/API** either, and covers federal totals — not the regional
  recruitment/casualty derivation.

### Is chart-scraping feasible? — technically yes, practically poor fit
- **Direct extraction = plot digitization** (WebPlotDigitizer-style pixel analysis, or OCR
  of the axis-labelled bars). Doable for a one-off, but **fragile and approximate**: it
  breaks every time he restyles a chart, can't be trusted to ±, and yields a handful of
  quarterly points — not a clean time series. A bad fit for our daily CI→R2→SQLite pattern,
  and the data only updates **quarterly** anyway. Not recommended as an ingestion source.
- **The right path is the upstream, not the charts.** His inputs are *public Russian
  Finance Ministry data* — federal budget execution + **regional budget execution reports**
  (roiv finance portals / budget.gov.ru / "Электронный бюджет"). Reconstructing his numbers
  means our own **research-grade scraper** of regional budget execution lines (signing
  bonuses, death compensation) + re-implementing the bonus-division methodology. That's a
  heavy, Russian-language, multi-source build (each region publishes differently) — far more
  than a CSV pull, in the same "build our own" tier as the RU-MoD scraper (§3).
- **Verdict:** keep as a **human cross-check / reference** for now (cite his posts when
  presenting GSUA/MoD personnel figures — his budget-derived KIA is a useful independent
  comparison). Treat full ingestion as a long-term GAP: it needs an upstream Russian-budget
  scraper, not chart-scraping, and its quarterly cadence suits a periodic view, not the
  daily dashboard. If pursued, ask Kluge directly — researchers often share the underlying
  spreadsheet on request, which would moot the whole extraction problem.

---

## 8. Territorial control — frontline / area held (mappers)

The question "who publishes *structured* data?" splits these sharply: two ship
machine-readable GeoJSON; the rest are images or charts only. Note this is **GIS
data (polygons), not the scalar daily-counts shape** the rest of the dashboard is
built on — a "territory lost/gained" view means computing polygon **area** per
snapshot (shapely/turf) and diffing consecutive days, plus handling large files.
Feasible as a **periodic (weekly/monthly) snapshot**, not a trivial CSV pull.

### DeepState (deepstatemap.live) — LIVE — ✅ STRUCTURED (best option)
- Ukrainian OSINT map, blended from UA MoD data + confirmed OSINT. ~2–3 day lag.
- **Public GeoJSON API** (verified 2026-05): `https://deepstatemap.live/api/history/last`
  returns the full FeatureCollection of occupied/frontline polygons; historical snapshots
  via `https://deepstatemap.live/api/history/<unix_ts>/geojson`. (The `/api/history` index
  itself returns `Unauthorized`, but `last` + per-timestamp `geojson` are open.)
- **Daily mirror:** `github.com/cyterat/deepstate-map-data` — Multipolygon GeoJSON of
  occupied territory, GPL-3.0, **updated daily 03:00 UTC** (pushed 2026-05-26). Cleaner to
  consume than the API for a daily CI snapshot.
- **Area methodology reference:** `github.com/conflict-investigations/deepstatemap-territory`
  — scrapes DeepState and computes total "occupied" km². STALE (last push 2023, no license),
  but the notebook shows exactly how to turn the polygons into a km² time series.
- To produce "territory gained/lost/day": snapshot the GeoJSON, compute area (equal-area
  projection), diff vs. previous snapshot. Heavy-ish geometry + large daily files, but the
  pipeline shape (snapshot → derive → store) matches ours.

### Playfra (playframap.github.io) — LIVE — ✅ STRUCTURED
- Repo `playframap/playframap.github.io` (pushed 2026-05-26) ships **daily
  `data/grayzone<DDMMYY>.geojson`** frontline/grayzone polygons (~85 files, raw-fetchable
  via raw.githubusercontent / GitHub Pages). Second independent structured source / good
  cross-check against DeepState. License not stated on the repo — confirm before use.

### ISW / Critical Threats — reference only (NOT structured)
- criticalthreats.org Russian Offensive Campaign Assessment + an interactive **ArcGIS
  StoryMap** (storymaps.arcgis.com), updated daily, with monthly time-lapse. **No official
  GeoJSON/shapefile/CSV download.** The backing ArcGIS FeatureServer can sometimes be queried
  unofficially, but it's undocumented and ToS-grey. Treat as authoritative human analysis /
  cross-check, not an ingestion source.

### War Mapper / "Poulet Volant" (warmapper.org) — numbers, but NOT structured
- Weekly control updates + **monthly territorial-change charts in km²** (UA side collated by
  OwlOSINT). The figures are exactly what we'd want, but published as **charts + Telegram
  posts**, with no documented data file/API (site returns 403 to fetchers). Same situation
  as Janis Kluge (§7): real numbers, no machine-readable feed → cross-check, or ask directly.

### Rybar (rybar.ru) — NOT structured (+ bias caveat)
- Pro-Russian (anonymous, ~1.1M followers). Maps shared as **images on Telegram**; an online
  map at `map.rybar.ru` is **subscription-gated**. No free structured export. Russian-MoD-aligned
  framing — only useful as an adversary-narrative counterpoint, not a data source.

### AMK Mapping — NOT structured
- English pro-Ukrainian OSINT Telegram/X channel (~46k). Control maps + strike overlays as
  **images / an interactive map**, updated several times daily. No data export.

**Bottom line:** of the five you named, only **DeepState** publishes a real structured feed
(GeoJSON API + GPL daily GitHub mirror); **Playfra** is a strong second (daily GeoJSON in a
public repo). ISW, War Mapper, Rybar, and AMK are image/chart-only → reference & cross-check,
not ingestion. If we add a territory view, DeepState is the primary source and the work is
GIS area-diffing on a periodic (not daily-scalar) cadence.

---

## Suggested integration order

1. **russian-casualties.in.ua** — national GSUA totals. Lowest effort: pre-differenced daily
   values + open CORS = direct browser fetch, no scraper/R2. New site-picker entry.
2. **piterfm "Massive Missile Attacks"** — air defense launched-vs-intercepted. High value,
   closest to existing SBS/GSUA work. Needs a small ingest (Kaggle CSV → our DB/R2).
3. **leedrake5 Oryx** — OSINT-verified equipment as a counterweight to government claims.

Open question / gap: Russian MoD daily claims (category 3) would need a dedicated scraper.
