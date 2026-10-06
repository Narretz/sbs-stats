-- Derived tables for the GSUA app copy (ru-attacks-gsua.app.db), run by
-- scripts/build_app_db.py --sql. The frontend reads that copy over HTTP range
-- requests (sql.js-httpvfs), where a query costs a request per page it touches:
-- an answer that needs the whole history belongs here, computed once per
-- upload, rather than on every page view. The authoritative DB doesn't carry
-- these — they are display data, derived entirely from it.

-- The direction picker's list, ranked by all-time attacks (the ranking keys
-- each direction's series colour). Computed live it walked every direction row
-- ever recorded — ~580 pages, ~2.3 MB, the heaviest read of the daily page —
-- for ~25 names. Same rows as the live query in useDatabaseGsua.ts
-- (queryDirectionList), which stays as the fallback for a copy built without
-- this script: the latest version of each post only, directions with any
-- attacks at all.
DROP TABLE IF EXISTS direction_totals;
CREATE TABLE direction_totals AS
  SELECT d.direction AS direction,
         SUM(COALESCE(d.attacks, 0)) AS total,
         MAX(p.date) AS last_date
  FROM directions d
  INNER JOIN posts p
    ON p.source = d.source AND p.source_id = d.source_id AND p.scraped_at = d.scraped_at
  WHERE NOT EXISTS (
    SELECT 1 FROM posts n
    WHERE n.source = p.source AND n.source_id = p.source_id
      AND n.scraped_at > p.scraped_at
  )
  GROUP BY d.direction
  HAVING total > 0;

-- Monthly sums of each metric over the canonical day — per date the latest
-- snapshot, telegram first, then by source name. The twin of the frontend's
-- canonicalDailySql + pickCanonicalDaily + sumMetricsByMonth
-- (src/utils/gsuaSql.ts), which gsuaSql.test.ts holds it to. A metric no day
-- reported sums to 0, as there. The frontend reads only completed months from
-- here: the recent ones, which a scrape can still change, it queries live.
DROP TABLE IF EXISTS gsua_monthly;
CREATE TABLE gsua_monthly AS
  WITH latest AS (
    SELECT p.* FROM posts p
    WHERE NOT EXISTS (
      SELECT 1 FROM posts n
      WHERE n.source = p.source AND n.source_id = p.source_id
        AND n.scraped_at > p.scraped_at
    )
  ),
  per_date_source AS (
    SELECT date, source, MAX(snapshot_at) AS latest_snapshot,
           MAX(combat_engagements) AS combat_engagements, MAX(missile_strikes) AS missile_strikes,
           MAX(missiles_used) AS missiles_used, MAX(air_strikes) AS air_strikes,
           MAX(kabs_dropped) AS kabs_dropped, MAX(kamikaze_drones) AS kamikaze_drones,
           MAX(shellings) AS shellings, MAX(mlrs_shellings) AS mlrs_shellings,
           MAX(targets_destroyed) AS targets_destroyed
    FROM latest
    GROUP BY date, source, snapshot_at
  ),
  last_per_date_source AS (
    SELECT date, source, MAX(latest_snapshot) AS latest_snapshot
    FROM per_date_source
    GROUP BY date, source
  ),
  canonical AS (
    SELECT p.*, ROW_NUMBER() OVER (
             PARTITION BY p.date
             ORDER BY CASE p.source WHEN 'telegram' THEN 0 ELSE 1 END, p.source
           ) AS rn
    FROM per_date_source p
    INNER JOIN last_per_date_source l
      ON p.date = l.date AND p.source = l.source AND p.latest_snapshot = l.latest_snapshot
  )
  SELECT substr(date, 1, 7) AS month,
         COALESCE(SUM(combat_engagements), 0) AS combat_engagements,
         COALESCE(SUM(missile_strikes), 0) AS missile_strikes,
         COALESCE(SUM(missiles_used), 0) AS missiles_used,
         COALESCE(SUM(air_strikes), 0) AS air_strikes,
         COALESCE(SUM(kabs_dropped), 0) AS kabs_dropped,
         COALESCE(SUM(kamikaze_drones), 0) AS kamikaze_drones,
         COALESCE(SUM(shellings), 0) AS shellings,
         COALESCE(SUM(mlrs_shellings), 0) AS mlrs_shellings,
         COALESCE(SUM(targets_destroyed), 0) AS targets_destroyed
  FROM canonical
  WHERE rn = 1
  GROUP BY substr(date, 1, 7);

-- Per month: the canonical days' combat engagements and each direction's
-- fair share of them — the direction coverage chart's monthly view. The twin
-- of coverageMonthlySql (src/utils/gsuaSql.ts), unfloored; gsuaSql.test.ts
-- holds the two to the same rows. Computed live this was the site's heaviest
-- read: ~1,070 pages per visit of the monthly page.
DROP TABLE IF EXISTS gsua_direction_monthly;
CREATE TABLE gsua_direction_monthly AS
  WITH latest_posts AS (
    SELECT p.* FROM posts p
    WHERE NOT EXISTS (
      SELECT 1 FROM posts n
      WHERE n.source = p.source AND n.source_id = p.source_id
        AND n.scraped_at > p.scraped_at
    )
  ),
  per_date_source_snap AS (
    SELECT date, source, snapshot_at, MAX(combat_engagements) AS combat_engagements
    FROM latest_posts
    WHERE snapshot_at IS NOT NULL
    GROUP BY date, source, snapshot_at
  ),
  best_per_date AS (
    SELECT date, source, snapshot_at, combat_engagements
    FROM (
      SELECT *, ROW_NUMBER() OVER (
               PARTITION BY date
               ORDER BY CASE source WHEN 'telegram' THEN 0 ELSE 1 END, snapshot_at DESC
             ) AS rn
      FROM per_date_source_snap
    ) t
    WHERE rn = 1
  ),
  month_totals AS (
    SELECT substr(date, 1, 7) AS month, SUM(combat_engagements) AS total
    FROM best_per_date
    GROUP BY substr(date, 1, 7)
  ),
  per_date_direction AS (
    SELECT b.date AS date, d.direction AS direction,
           MAX(d.attacks * 1.0 / d.attacks_group_size) AS attacks
    FROM best_per_date b
    LEFT JOIN latest_posts p
      ON p.source = b.source AND p.date = b.date AND p.snapshot_at = b.snapshot_at
    LEFT JOIN directions d
      ON d.source = p.source AND d.source_id = p.source_id AND d.scraped_at = p.scraped_at
    GROUP BY b.date, d.direction
  ),
  month_direction_attacks AS (
    SELECT substr(date, 1, 7) AS month, direction, SUM(attacks) AS attacks
    FROM per_date_direction
    GROUP BY substr(date, 1, 7), direction
  )
  SELECT m.month AS date, m.total, a.direction, a.attacks
  FROM month_totals m
  LEFT JOIN month_direction_attacks a ON a.month = m.month;
