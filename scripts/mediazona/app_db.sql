-- Mediazona's app copy (build_app_db.py --sql): the latest version of every
-- week and nothing else. The app reads only that, and the history of every
-- release since 2023 is ~5x the file it downloads whole. Same ordering as
-- `latest_per_week` in ingest.py and the hook — by release, then by ingest;
-- test_ingest.py holds the copy to the full DB's latest view. Schema unchanged,
-- so the hook runs the same query on either.

DELETE FROM weekly_roles WHERE rowid NOT IN (
  SELECT rowid FROM (
    SELECT rowid, ROW_NUMBER() OVER (
      PARTITION BY week ORDER BY published_at DESC, scraped_at DESC) AS rn
    FROM weekly_roles
  ) WHERE rn = 1
);

DELETE FROM weekly_estimate WHERE rowid NOT IN (
  SELECT rowid FROM (
    SELECT rowid, ROW_NUMBER() OVER (
      PARTITION BY week ORDER BY published_at DESC, scraped_at DESC) AS rn
    FROM weekly_estimate
  ) WHERE rn = 1
);

-- A week a newer release dropped: its latest version is the empty row.
DELETE FROM weekly_estimate WHERE documented IS NULL AND estimate IS NULL;

-- Where each release version came from, and the article pages it was published
-- in: provenance for the full DB, not read by the app.
DROP TABLE IF EXISTS releases;
DROP TABLE IF EXISTS articles;
