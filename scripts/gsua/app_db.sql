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
