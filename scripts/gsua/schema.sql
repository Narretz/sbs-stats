-- General Staff scraper SQLite schema.
--
-- Loaded by scrape_general_staff.py at startup (and by reparse.py via its
-- import of that module). Idempotent — every statement is CREATE … IF NOT
-- EXISTS — so it's safe to re-run against an existing DB.
--
-- One-shot migrations (the May-2026 rename from `message_id` to
-- `(source, source_id)`, and the edit-versioning change that adds `scraped_at`
-- to the primary key) stay in Python; this file describes only the *target*
-- shape.
--
-- EDIT VERSIONING: a Telegram post can be edited after we first store it, so
-- `scraped_at` is part of the primary key — an edit inserts a NEW row (a new
-- version) rather than overwriting, and no version is ever lost. Every read
-- resolves the latest `scraped_at` per (source, source_id). `scraped_at` was
-- already a populated column pre-versioning, so historical rows keep their
-- original value (no NULLs, no backfill needed).

CREATE TABLE IF NOT EXISTS posts (
    source              TEXT    NOT NULL,    -- 'telegram' | 'facebook'
    source_id           TEXT    NOT NULL,    -- Telegram message_id or FB story_fbid, as text
    date                TEXT    NOT NULL,    -- day the report is about (Kyiv local)
    message_date        TEXT    NOT NULL,    -- source post timestamp (UTC)
    snapshot_at         TEXT,                -- 'станом на HH:MM ...' parsed (Kyiv local, naive)
    text                TEXT    NOT NULL,
    url                 TEXT    NOT NULL,
    combat_engagements  INTEGER,
    missile_strikes     INTEGER,
    missiles_used       INTEGER,
    air_strikes         INTEGER,
    kabs_dropped        INTEGER,
    kamikaze_drones     INTEGER,
    shellings           INTEGER,
    mlrs_shellings      INTEGER,
    scraped_at          TEXT    NOT NULL,    -- ingest time; also the version key
    notes               TEXT,                -- parser-correction marker; NULL for clean rows
    part                TEXT,                -- "1/2"/"2/2"/… for multipart posts; NULL for single-part
    PRIMARY KEY (source, source_id, scraped_at)
);

CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date);

-- Covering index for the aggregate frontend queries (queryDaily, querySnapshots,
-- queryGlobalStats, queryMonthly). They resolve the latest scraped_at per
-- (source, source_id) then read metrics ordered by (date, source, snapshot_at);
-- SQLite can satisfy them from this index without touching the bulky `text`.
CREATE INDEX IF NOT EXISTS idx_posts_metrics ON posts(
    date, source, source_id, scraped_at, snapshot_at,
    combat_engagements, missile_strikes, missiles_used,
    air_strikes, kabs_dropped, kamikaze_drones,
    shellings, mlrs_shellings
);

-- Version resolution + directions join: latest scraped_at per (source, source_id)
-- is index-only via the PK; this adds date/snapshot for the join projection.
CREATE INDEX IF NOT EXISTS idx_posts_pk_date_snap
    ON posts(source, source_id, scraped_at, date, snapshot_at);

CREATE TABLE IF NOT EXISTS directions (
    source      TEXT    NOT NULL,
    source_id   TEXT    NOT NULL,
    scraped_at  TEXT    NOT NULL,    -- matches the parent post version
    direction   TEXT    NOT NULL,
    attacks     INTEGER,
    ongoing     INTEGER,
    PRIMARY KEY (source, source_id, scraped_at, direction),
    FOREIGN KEY (source, source_id, scraped_at)
        REFERENCES posts(source, source_id, scraped_at) ON DELETE CASCADE
);

-- Covering index for the per-direction frontend queries. Includes scraped_at so
-- the (direction → post version) join and the GROUP BY direction summary stay
-- index-only.
CREATE INDEX IF NOT EXISTS idx_directions_dir_full
    ON directions(direction, source, source_id, scraped_at, attacks, ongoing);

-- One row per (source, date, snapshot_at), over the LATEST version of each post,
-- merging continuation parts. Late-2024 Telegram posts were occasionally split
-- into "(1/2)" (aggregate metrics) and "(2/2)" (per-direction breakdowns) at the
-- message-length limit; the MAX() aggregates COALESCE them. Telegram and
-- Facebook rows for the same date/snapshot stay distinct.
CREATE VIEW IF NOT EXISTS daily_combined AS
SELECT
    source,
    date,
    snapshot_at,
    MIN(message_date)              AS message_date,
    GROUP_CONCAT(source_id, ',')   AS source_ids,
    MAX(combat_engagements)        AS combat_engagements,
    MAX(missile_strikes)           AS missile_strikes,
    MAX(missiles_used)             AS missiles_used,
    MAX(air_strikes)               AS air_strikes,
    MAX(kabs_dropped)              AS kabs_dropped,
    MAX(kamikaze_drones)           AS kamikaze_drones,
    MAX(shellings)                 AS shellings,
    MAX(mlrs_shellings)            AS mlrs_shellings,
    GROUP_CONCAT(notes, ' | ')     AS notes
FROM posts p
WHERE NOT EXISTS (
    SELECT 1 FROM posts n
    WHERE n.source = p.source AND n.source_id = p.source_id
      AND n.scraped_at > p.scraped_at
)
GROUP BY source, date, snapshot_at;
