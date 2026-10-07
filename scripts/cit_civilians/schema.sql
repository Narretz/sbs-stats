-- CIT civilian casualties (scripts/cit_civilians/ingest.py).
-- `reports.body_text` keeps the stitched post text so a later parser fix can be
-- applied with `--reparse` instead of re-scraping (CLAUDE.md: a re-scrape
-- re-ingests identical text and changes nothing). Also read by
-- e2e/build-fixtures.mjs, so the synthetic fixture can't drift from it.
CREATE TABLE IF NOT EXISTS reports (
  post_id        INTEGER NOT NULL,  -- head post of the summary
  scraped_at     TEXT NOT NULL,     -- UTC ISO8601, our ingest timestamp
  posted_at      TEXT NOT NULL,     -- UTC ISO8601, the Telegram post timestamp
  part_ids       TEXT NOT NULL,     -- '10889,10890' — every post stitched in
  url            TEXT NOT NULL,
  report_type    TEXT NOT NULL,     -- 'daily_summary' | 'weekend_summary'
  window_days    INTEGER NOT NULL,  -- 1, or 2 for a weekend post (48h bucket)
  window_start   TEXT,              -- UTC ISO8601 of "20:00 DD.MM.YYYY –"
  window_end     TEXT,              -- UTC ISO8601 of "– 20:00 DD.MM.YYYY"
  report_date    TEXT NOT NULL,     -- 'YYYY-MM-DD', MSK date of window_end
  date_basis     TEXT NOT NULL,     -- 'window' | 'post_time' (2023 era)
  stated_killed  INTEGER,           -- from the closing "Таким образом" line
  stated_injured INTEGER,
  sum_killed     INTEGER NOT NULL,  -- parsed daily + amendment rows
  sum_injured    INTEGER NOT NULL,
  reconciled     INTEGER,           -- 1 agree / 0 differ / NULL no total line
  body_text      TEXT NOT NULL,
  text_hash      TEXT NOT NULL,     -- sha256 of body_text; cheap edit detector
  PRIMARY KEY (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_reports_date ON reports (report_date);

CREATE TABLE IF NOT EXISTS casualties (
  post_id     INTEGER NOT NULL,
  scraped_at  TEXT NOT NULL,
  seq         INTEGER NOT NULL,  -- ordinal within the post; keeps source order
  -- 'daily'      the window's own regional rows
  -- 'amendment'  casualties learned today for an EARLIER date; additive, and
  --              counted in CIT's own headline total
  -- 'adjustment' a correction CIT does NOT count in that headline: a
  --              retraction, a downward restatement, or our own −1 injured
  --              when someone already counted as injured has died
  kind        TEXT NOT NULL,
  event_date  TEXT,              -- 'YYYY-MM-DD'; NULL when indivisibly multi-dated
  event_dates TEXT,              -- comma-joined list when several were named
  date_basis  TEXT NOT NULL,     -- window|post_time|explicit|split|multi|unknown
  region_key  TEXT NOT NULL,     -- slug, 'unknown' when no region was matched
  region_raw  TEXT NOT NULL,     -- verbatim Russian phrase, for audit
  occupied    INTEGER,           -- 1 occupied / 0 gov-controlled / NULL unstated
  country     TEXT,              -- 'UA' | 'RU' | NULL for an unknown region
  killed      INTEGER NOT NULL,  -- signed; negative on an adjustment
  injured     INTEGER NOT NULL,  -- signed
  count_inferred INTEGER NOT NULL DEFAULT 0,  -- count came from a bare noun
  reason      TEXT,              -- excluded_by_source|restated_by_source|died_of_wounds
  raw_label   TEXT NOT NULL,
  PRIMARY KEY (post_id, scraped_at, seq),
  FOREIGN KEY (post_id, scraped_at) REFERENCES reports (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_casualties_event ON casualties (event_date);
CREATE INDEX IF NOT EXISTS ix_casualties_region ON casualties (region_key);

-- Latest stored version of each post.
CREATE VIEW IF NOT EXISTS reports_latest AS
  SELECT r.* FROM reports r
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON r.post_id = l.post_id AND r.scraped_at = l.ms;

CREATE VIEW IF NOT EXISTS casualties_latest AS
  SELECT c.* FROM casualties c
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON c.post_id = l.post_id AND c.scraped_at = l.ms;

-- THE HEADLINE SERIES. CIT's own figure for each report day, straight off the
-- post's closing sentence. This is what the charts plot: it parses on ~96% of
-- posts and never depends on the regional breakdown being complete.
CREATE VIEW IF NOT EXISTS daily_stated AS
  SELECT report_date, post_id, stated_killed AS killed, stated_injured AS injured,
         reconciled, date_basis, report_type, window_days
  FROM reports_latest
  WHERE stated_killed IS NOT NULL OR stated_injured IS NOT NULL;

-- As first reported: the region rows for each report window, nothing else.
CREATE VIEW IF NOT EXISTS daily_reported AS
  SELECT event_date, SUM(killed) AS killed, SUM(injured) AS injured
  FROM casualties_latest WHERE kind = 'daily' AND event_date IS NOT NULL
  GROUP BY event_date;

-- Revised: what we now believe happened on each day, once later corrections
-- are folded back onto the date they belong to. This is the multi-post row —
-- derived, so it can never go stale, and it names its sources.
CREATE VIEW IF NOT EXISTS daily_revised AS
  SELECT event_date,
         SUM(killed) AS killed,
         SUM(injured) AS injured,
         COUNT(DISTINCT post_id) AS source_post_count,
         group_concat(DISTINCT post_id) AS source_post_ids
  FROM casualties_latest WHERE event_date IS NOT NULL
  GROUP BY event_date;

-- Corrections that name several dates indivisibly ("ещё семи пострадавших за
-- 26, 28 и 30 августа" — 7 people, 3 days). Surfaced rather than dropped, so
-- a chart can show them as an unattributed band instead of pretending.
CREATE VIEW IF NOT EXISTS corrections_unattributed AS
  SELECT post_id, seq, kind, event_dates, region_key, killed, injured, raw_label
  FROM casualties_latest WHERE event_date IS NULL;
