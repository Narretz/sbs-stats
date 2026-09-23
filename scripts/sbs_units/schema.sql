-- SBS sub-units SQLite schema.
--
-- Loaded by ingest.py at startup, and by e2e/build-fixtures.mjs so the
-- synthetic test DB has the same shape as the real one rather than a
-- hand-copied approximation of it. Idempotent — every statement is
-- CREATE … IF NOT EXISTS — so it's safe to re-run against an existing DB.
--
-- The per-target columns (`hit_<id>` / `destroyed_<id>`) are deliberately NOT
-- here: which target classes exist is the source's decision, discovered from
-- the first payload of a run and added by `ensure_columns`. This file
-- describes only the fixed shape.
--
-- CAPTURE BUCKETS: the stat tables are append-on-change like every scraped
-- dataset here, but with a second brake — `capture_bucket` is part of the
-- primary key, so a run whose bucket row already exists updates it in place
-- instead of appending. The bucket is the Kyiv day for `unit_daily_stats` and
-- the Monday of the Kyiv ISO week for the other two. That decouples row count
-- from run frequency; see README.md for why the monthly grain doesn't want a
-- per-run version and the daily grain does.

CREATE TABLE IF NOT EXISTS units (
    slug            TEXT PRIMARY KEY,   -- URL-facing id; every stat row references it
    subdivision_id  TEXT NOT NULL UNIQUE,
    division_id     TEXT,
    title_uk        TEXT,
    title_en        TEXT,
    color           TEXT,
    display_order   INTEGER,
    -- Derived from "still has a live daily period", never a hand-kept list:
    -- the API flags nothing when a unit retires, it just stops issuing
    -- periods for it.
    active          INTEGER NOT NULL,
    has_daily       INTEGER NOT NULL,
    first_month     TEXT,               -- "YYYY-MM", earliest monthly period offered
    last_month      TEXT,
    scraped_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unit_daily_stats (
    unit_slug          TEXT NOT NULL,
    date               DATE NOT NULL,   -- the calendar day measured
    capture_bucket     TEXT NOT NULL,   -- Kyiv day of the snapshot
    captured_at        TEXT NOT NULL,
    data_collected_at  TEXT,
    last_updated       TEXT,
    personnel_killed            INTEGER,
    personnel_wounded           INTEGER,
    total_targets_hit           INTEGER,
    total_targets_destroyed     INTEGER,
    total_personnel_casualties  INTEGER,
    flights_strike              INTEGER,
    flights_recon               INTEGER,
    PRIMARY KEY (unit_slug, date, capture_bucket)
);

CREATE TABLE IF NOT EXISTS unit_monthly_stats (
    unit_slug          TEXT NOT NULL,
    date               DATE NOT NULL,   -- the month's 1st
    capture_bucket     TEXT NOT NULL,   -- Monday of the Kyiv ISO week
    captured_at        TEXT NOT NULL,
    data_collected_at  TEXT,
    last_updated       TEXT,
    personnel_killed            INTEGER,
    personnel_wounded           INTEGER,
    total_targets_hit           INTEGER,
    total_targets_destroyed     INTEGER,
    total_personnel_casualties  INTEGER,
    flights_strike              INTEGER,
    flights_recon               INTEGER,
    PRIMARY KEY (unit_slug, date, capture_bucket)
);

CREATE TABLE IF NOT EXISTS unit_yearly_stats (
    unit_slug          TEXT NOT NULL,
    date               DATE NOT NULL,   -- the year's Jan 1
    capture_bucket     TEXT NOT NULL,   -- Monday of the Kyiv ISO week
    captured_at        TEXT NOT NULL,
    data_collected_at  TEXT,
    last_updated       TEXT,
    personnel_killed            INTEGER,
    personnel_wounded           INTEGER,
    total_targets_hit           INTEGER,
    total_targets_destroyed     INTEGER,
    total_personnel_casualties  INTEGER,
    flights_strike              INTEGER,
    flights_recon               INTEGER,
    PRIMARY KEY (unit_slug, date, capture_bucket)
);
