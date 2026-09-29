-- President's weekly strike tally (zelensky-weekly) SQLite schema.
--
-- Loaded by ingest.py at startup (and meant for e2e/build-fixtures.mjs once a
-- frontend view exists, so the synthetic DB has the real shape). Idempotent —
-- every statement is CREATE … IF NOT EXISTS.
--
-- `reports.body_text` keeps the raw post text so a parser fix is applied with
-- `--reparse` instead of a re-scrape (CLAUDE.md: a re-scrape re-ingests
-- identical text and changes nothing).

CREATE TABLE IF NOT EXISTS reports (
  post_id      INTEGER NOT NULL,
  scraped_at   TEXT NOT NULL,     -- UTC ISO8601, our ingest timestamp
  posted_at    TEXT NOT NULL,     -- UTC ISO8601, the Telegram post timestamp
  -- 'weekly'         — a whole-week tally (posted Sat–Tue, or "last week")
  -- 'weekly_partial' — "this week" said Wed–Fri: the week SO FAR. Stored
  --                    because it was said, never charted as a week.
  report_type  TEXT NOT NULL,
  lang         TEXT NOT NULL,     -- 'uk' | 'en'
  week_ref     TEXT NOT NULL,     -- 'this' | 'last' — as worded in the post
  -- The week is never dated in the post; these are DERIVED from posted_at
  -- (parse.py week_bounds). ISO week, Monday–Sunday, Kyiv.
  period       TEXT NOT NULL,     -- 'YYYY-Www'
  period_start TEXT NOT NULL,     -- Monday 'YYYY-MM-DD'
  period_end   TEXT NOT NULL,     -- Sunday 'YYYY-MM-DD'
  url          TEXT NOT NULL,     -- https://t.me/<channel>/<post_id>
  tally_text   TEXT NOT NULL,     -- the sentence(s) the counters came from
  body_text    TEXT NOT NULL,     -- the whole post
  text_hash    TEXT NOT NULL,     -- sha256 of body_text; cheap edit detector
  PRIMARY KEY (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_reports_period ON reports (period);

CREATE TABLE IF NOT EXISTS counters (
  post_id    INTEGER NOT NULL,
  scraped_at TEXT NOT NULL,
  category   TEXT NOT NULL,       -- drones | bombs | missiles
  value      INTEGER NOT NULL,
  -- The source rounds everything and hedges most of it:
  --   exact    — a bare number ("74 ракети")
  --   at_least — понад / більше / more than
  --   at_most  — майже / almost
  --   approx   — близько / приблизно / about
  bound      TEXT NOT NULL,
  qualifier  TEXT NOT NULL,       -- the hedge word verbatim, '' when bare
  raw_label  TEXT NOT NULL,       -- e.g. "понад 3170 ударних дронів"
  PRIMARY KEY (post_id, scraped_at, category),
  FOREIGN KEY (post_id, scraped_at) REFERENCES reports (post_id, scraped_at)
);

-- Latest stored version of each post.
CREATE VIEW IF NOT EXISTS reports_latest AS
  SELECT r.* FROM reports r
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON r.post_id = l.post_id AND r.scraped_at = l.ms;

CREATE VIEW IF NOT EXISTS counters_latest AS
  SELECT c.* FROM counters c
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON c.post_id = l.post_id AND c.scraped_at = l.ms;

-- One row per week: the series a chart reads. When a week has more than one
-- whole-week tally (the Sunday post and the evening address repeating it, a
-- Monday "last week" recap, the English translation), the one naming the MOST
-- weapons wins — the evening repeat of 2025-10-26 drops the bomb count the
-- morning post had — then Ukrainian, then the latest. A category the chosen
-- post doesn't name is NULL, not 0: the source didn't say.
CREATE VIEW IF NOT EXISTS weekly AS
  WITH ranked AS (
    SELECT r.*, ROW_NUMBER() OVER (
      PARTITION BY r.period
      ORDER BY n.n DESC, (r.lang = 'uk') DESC, r.posted_at DESC, r.post_id DESC
    ) AS rn
    FROM reports_latest r
    JOIN (SELECT post_id, COUNT(*) AS n FROM counters_latest GROUP BY post_id) n
      ON n.post_id = r.post_id
    WHERE r.report_type = 'weekly'
  )
  SELECT
    k.period, k.period_start, k.period_end, k.post_id, k.posted_at, k.url,
    MAX(CASE WHEN c.category = 'drones'   THEN c.value END) AS drones,
    MAX(CASE WHEN c.category = 'drones'   THEN c.bound END) AS drones_bound,
    MAX(CASE WHEN c.category = 'bombs'    THEN c.value END) AS bombs,
    MAX(CASE WHEN c.category = 'bombs'    THEN c.bound END) AS bombs_bound,
    MAX(CASE WHEN c.category = 'missiles' THEN c.value END) AS missiles,
    MAX(CASE WHEN c.category = 'missiles' THEN c.bound END) AS missiles_bound
  FROM ranked k
  LEFT JOIN counters_latest c ON c.post_id = k.post_id
  WHERE k.rn = 1
  GROUP BY k.period
  ORDER BY k.period;
