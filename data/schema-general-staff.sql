-- General Staff scraper SQLite schema.
--
-- Loaded by scrape_general_staff.py at startup (and by reparse.py via its
-- import of that module). Idempotent — every statement is CREATE … IF NOT
-- EXISTS — so it's safe to re-run against an existing DB.
--
-- One-shot migrations (e.g. the May-2026 rename from `message_id` to
-- `(source, source_id)`) stay in Python; this file describes only the
-- *target* shape.

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
    scraped_at          TEXT    NOT NULL,
    notes               TEXT,                -- parser-correction marker; NULL for clean rows
    part                TEXT,                -- "1/2"/"2/2"/… for multipart posts; NULL for single-part
    PRIMARY KEY (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date);

CREATE TABLE IF NOT EXISTS directions (
    source      TEXT    NOT NULL,
    source_id   TEXT    NOT NULL,
    direction   TEXT    NOT NULL,
    attacks     INTEGER,
    ongoing     INTEGER,
    PRIMARY KEY (source, source_id, direction),
    FOREIGN KEY (source, source_id) REFERENCES posts(source, source_id) ON DELETE CASCADE
);

-- One row per (source, date, snapshot_at), merging continuation parts.
-- Late-2024 Telegram posts were occasionally split into "(1/2)" (aggregate
-- metrics) and "(2/2)" (per-direction breakdowns) at the message-length limit.
-- The MAX() aggregates COALESCE them so charting tools see one logical report
-- per slot. For per-direction data, query `directions` joined on
-- (source, source_id). Telegram and Facebook rows for the same date/snapshot
-- stay distinct so cross-source mismatches surface rather than silently merge.
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
FROM posts
GROUP BY source, date, snapshot_at;
