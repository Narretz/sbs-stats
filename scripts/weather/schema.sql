-- Front-line weather, per GSUA direction — scripts/weather/ingest.py.
--
-- Everything here is Open-Meteo MODEL output, never station observations.
-- What is stored is the weather; the drone / ground ratings are derived from
-- it in code (scripts/weather/assess.py, src/utils/weatherRating.ts) with the
-- thresholds in src/data/weatherRules.json, so changing a rule never needs a
-- migration.
--
-- Times are Europe/Kyiv local, 'YYYY-MM-DDTHH:MM', exactly as Open-Meteo
-- returns them with `timezone=Europe/Kyiv` — the same clock the SBS hours run
-- on. Units: °C, mm, cm (snowfall), m (visibility, snow depth), %, m/s,
-- m³/m³. fetched_at is UTC.

-- The sample points (sectors.py), as placed. `id` is stable and never reused:
-- the app copy keys on it instead of repeating the name on every row.
CREATE TABLE IF NOT EXISTS sectors (
    id      INTEGER PRIMARY KEY,
    key     TEXT NOT NULL UNIQUE,   -- primary GSUA direction label
    gsua    TEXT NOT NULL,          -- every GSUA label it stands for, comma-joined
    near    TEXT NOT NULL,
    lat     REAL NOT NULL,
    lon     REAL NOT NULL,
    placed  TEXT NOT NULL,          -- when the point was last re-placed (YYYY-MM)
    sort    INTEGER NOT NULL        -- north to south, the order the GS reports run in
);

-- The settled record: one row per sector and hour that has passed.
--
-- The deliberate exception to the repo's append-only rule. An hour's value is
-- a model estimate that the next runs refine (the Oct 11 fog's end moved from
-- 10:00 to 11:00 between two of them), so every run overwrites it — until it
-- is 48 h old, when it is marked settled and never written again. Keeping
-- every run's version instead would be ~25k rows a day of superseded
-- estimates; what was FORECAST in advance is kept, deliberately, in
-- forecast_snapshot below.
CREATE TABLE IF NOT EXISTS hourly (
    sector                  TEXT NOT NULL REFERENCES sectors(key),
    time                    TEXT NOT NULL,
    temperature_2m          REAL,
    apparent_temperature    REAL,
    precipitation           REAL,   -- mm over the preceding hour, snow's water included
    snowfall                REAL,
    weather_code            INTEGER,  -- WMO: 45/48 fog, 61–65 rain, 95+ thunderstorm
    visibility              REAL,
    cloud_cover_low         REAL,
    wind_speed_10m          REAL,
    wind_gusts_10m          REAL,
    soil_moisture_3_to_9cm  REAL,
    snow_depth              REAL,
    source                  TEXT NOT NULL,  -- 'forecast' (live API) | 'archive' (backfill)
    fetched_at              TEXT NOT NULL,
    settled                 INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sector, time)
) WITHOUT ROWID;

-- The latest forecast for the hours still ahead, replaced whole by every run.
-- Once an hour passes it moves to `hourly` on the next run.
CREATE TABLE IF NOT EXISTS forecast (
    sector                  TEXT NOT NULL REFERENCES sectors(key),
    time                    TEXT NOT NULL,
    temperature_2m          REAL,
    apparent_temperature    REAL,
    precipitation           REAL,
    snowfall                REAL,
    weather_code            INTEGER,
    visibility              REAL,
    cloud_cover_low         REAL,
    wind_speed_10m          REAL,
    wind_gusts_10m          REAL,
    soil_moisture_3_to_9cm  REAL,
    snow_depth              REAL,
    fetched_at              TEXT NOT NULL,
    PRIMARY KEY (sector, time)
) WITHOUT ROWID;

-- What the models said IN ADVANCE: the first run at or after 06:00 Kyiv each
-- day, for that day and the next, kept for good. It is what lets "fog was
-- forecast — did SBS still drop?" be asked later, and it can't be backfilled:
-- Open-Meteo's archive of past runs has no visibility, so the record starts
-- the day this ingest went live. Not in the app copy.
CREATE TABLE IF NOT EXISTS forecast_snapshot (
    snapshot_date           TEXT NOT NULL,  -- Kyiv date of the run
    sector                  TEXT NOT NULL REFERENCES sectors(key),
    time                    TEXT NOT NULL,
    temperature_2m          REAL,
    apparent_temperature    REAL,
    precipitation           REAL,
    snowfall                REAL,
    weather_code            INTEGER,
    visibility              REAL,
    cloud_cover_low         REAL,
    wind_speed_10m          REAL,
    wind_gusts_10m          REAL,
    soil_moisture_3_to_9cm  REAL,
    snow_depth              REAL,
    fetched_at              TEXT NOT NULL,
    PRIMARY KEY (snapshot_date, sector, time)
) WITHOUT ROWID;

-- One row per run, for freshness ("as of") and for reading back what a run
-- did when the numbers look odd.
CREATE TABLE IF NOT EXISTS runs (
    fetched_at      TEXT PRIMARY KEY,
    mode            TEXT NOT NULL,      -- 'live' | 'backfill'
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    hourly_changed  INTEGER NOT NULL,   -- rows inserted or updated in `hourly`
    forecast_rows   INTEGER NOT NULL,
    snapshot        INTEGER NOT NULL    -- 1 when this run stored the day's snapshot
);
