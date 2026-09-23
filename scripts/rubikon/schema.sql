-- Rubikon («Рубикон») SQLite schema.
--
-- Loaded by ingest.py at startup, and by e2e/build-fixtures.mjs so the
-- synthetic test DB has the same shape as the real one rather than a
-- hand-copied approximation of it. Idempotent — every statement is
-- CREATE … IF NOT EXISTS — so it's safe to re-run against an existing DB.
--
-- `reports.body_text` keeps the raw post text so a later parser fix can be
-- applied with `--reparse` instead of re-scraping (CLAUDE.md: a re-scrape
-- re-ingests identical text and changes nothing).

CREATE TABLE IF NOT EXISTS reports (
  post_id      INTEGER NOT NULL,
  scraped_at   TEXT NOT NULL,     -- UTC ISO8601, our ingest timestamp
  posted_at    TEXT NOT NULL,     -- UTC ISO8601, the Telegram post timestamp
  report_type  TEXT NOT NULL,     -- 'monthly' (GS recap) | 'monthly_digest'
  period       TEXT,              -- 'YYYY-MM' — the month the report covers
  period_start TEXT,              -- 'YYYY-MM-DD'
  period_end   TEXT,              -- 'YYYY-MM-DD'
  url          TEXT NOT NULL,     -- https://t.me/<channel>/<post_id>
  body_text    TEXT NOT NULL,
  text_hash    TEXT NOT NULL,     -- sha256 of body_text; cheap edit detector
  PRIMARY KEY (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_reports_period ON reports (period);

CREATE TABLE IF NOT EXISTS counters (
  post_id    INTEGER NOT NULL,
  scraped_at TEXT NOT NULL,
  category   TEXT NOT NULL,       -- personnel | tanks | … (see the two parsers;
                                  -- the digest series has its own namespace)
  kind       TEXT NOT NULL,       -- recap:  sorties | engaged | ew_suppressed
                                  -- digest: published_total | published_episodes
  value      INTEGER NOT NULL,
  -- 'exact', or 'at_least' where the source says "превысило N" (a floor).
  -- Only the digest series uses at_least so far; recap numbers are all bare.
  bound      TEXT NOT NULL DEFAULT 'exact',
  raw_label  TEXT,                -- verbatim Russian phrasing
  PRIMARY KEY (post_id, scraped_at, category),
  FOREIGN KEY (post_id, scraped_at) REFERENCES reports (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_counters_category ON counters (category);

-- Latest stored version of each post.
CREATE VIEW IF NOT EXISTS reports_latest AS
  SELECT r.* FROM reports r
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON r.post_id = l.post_id AND r.scraped_at = l.ms;

CREATE VIEW IF NOT EXISTS counters_latest AS
  SELECT c.* FROM counters c
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON c.post_id = l.post_id AND c.scraped_at = l.ms;
