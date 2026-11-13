-- The weather app copy (build_app_db.py --sql): what the SBS hourly page's
-- weather strip reads, and nothing else. The page fetches this file whole, so
-- it carries one compact table instead of the authoritative DB's three:
--
--   * only the fields the drone rating reads (src/utils/weatherRating.ts) —
--     the ground fields (soil, snow depth, felt temperature, low cloud) stay
--     in weather.db;
--   * values as scaled integers, which SQLite stores in 1–2 bytes instead of
--     8 — the hook divides them back (useDatabaseWeather);
--   * sectors by their stable id, the hour split off the date;
--   * past hours and the current forecast in one table, `forecast` = 1 marking
--     the hours that were still ahead when the run fetched them.
--
-- The forecast snapshots are for analysis against the full DB, not the app.

CREATE TABLE app_hourly (
    date      TEXT    NOT NULL,   -- YYYY-MM-DD, Kyiv
    hour      INTEGER NOT NULL,   -- 0–23, Kyiv
    sector    INTEGER NOT NULL,   -- sectors.id
    forecast  INTEGER NOT NULL,   -- 1 = still ahead when fetched
    t10       INTEGER,            -- temperature_2m, °C × 10
    pr10      INTEGER,            -- precipitation, mm × 10
    sn100     INTEGER,            -- snowfall, cm × 100
    code      INTEGER,            -- weather_code (WMO)
    vis       INTEGER,            -- visibility, m
    w10       INTEGER,            -- wind_speed_10m, m/s × 10
    g10       INTEGER,            -- wind_gusts_10m, m/s × 10
    PRIMARY KEY (date, hour, sector)
) WITHOUT ROWID;

INSERT INTO app_hourly
SELECT substr(h.time, 1, 10), CAST(substr(h.time, 12, 2) AS INTEGER), s.id, 0,
       CAST(round(h.temperature_2m * 10) AS INTEGER),
       CAST(round(h.precipitation * 10) AS INTEGER),
       CAST(round(h.snowfall * 100) AS INTEGER),
       h.weather_code,
       CAST(round(h.visibility) AS INTEGER),
       CAST(round(h.wind_speed_10m * 10) AS INTEGER),
       CAST(round(h.wind_gusts_10m * 10) AS INTEGER)
FROM hourly h JOIN sectors s ON s.key = h.sector;

-- OR IGNORE: on the DST change day a local hour can come back twice.
INSERT OR IGNORE INTO app_hourly
SELECT substr(f.time, 1, 10), CAST(substr(f.time, 12, 2) AS INTEGER), s.id, 1,
       CAST(round(f.temperature_2m * 10) AS INTEGER),
       CAST(round(f.precipitation * 10) AS INTEGER),
       CAST(round(f.snowfall * 100) AS INTEGER),
       f.weather_code,
       CAST(round(f.visibility) AS INTEGER),
       CAST(round(f.wind_speed_10m * 10) AS INTEGER),
       CAST(round(f.wind_gusts_10m * 10) AS INTEGER)
FROM forecast f JOIN sectors s ON s.key = f.sector;

DROP TABLE hourly;
DROP TABLE forecast;
DROP TABLE forecast_snapshot;
