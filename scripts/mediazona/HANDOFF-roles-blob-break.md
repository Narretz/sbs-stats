# Handoff: Mediazona ingest broken by an upstream bundle change (Aug 2026)

Status: **open**. Written 2026-08-19. Delete this file once the ingest is fixed.

`update-mediazona-db.yml` has failed every run since 2026-08-16 (last success
2026-08-13). The RU missile-attacks `status_data` failure that broke the same
day is already fixed (commit `1bcd53b` on this branch) — don't re-diagnose it.

## Failure

```
File "scripts/mediazona/ingest.py", line 209, in _find_roles_blob
RuntimeError: no roles blob (dict of equal-length int lists) in bundle
```

## What's established

- Mediazona shipped a new JS bundle between Aug 13 and Aug 16:
  - Aug 13 (ok):   `main.69ed843e3e21741756d7.js.br`
    → `7 JSON blobs; roles=21 cats × 1618 days; estimate=205 rows; summary=28 cats`
  - Aug 19 (fail): `main.59f5309b15808da7fd22.js.br`
- The article URL (`MEDIAZONA_ARTICLE_URL`, still
  `https://en.zona.media/article/2026/06/19/casualties_eng-trl`) is fine, and
  blob extraction still works: `_find_estimate_blob` passes and execution only
  dies at `_find_roles_blob`. So the *roles* blob alone changed shape against
  the heuristic at `ingest.py:203-209` (≥10 keys, all values lists, equal
  lengths, first 20 values `int`). Untested candidates: nulls in the trailing
  right-censored days, floats instead of ints, a nested/wrapped structure,
  unequal series lengths.
- No code change of ours is involved — nothing touched `scripts/mediazona/`
  for well over a week before the break.
- The guard did its job: R2's `mediazona.db` is intact, just stale since Aug 13.

## Next step

Dump the new bundle's blob shapes (type, key count, value types, list lengths
per blob) and compare against the 7-blob layout the code assumes. Then fix the
detector — but **also re-verify `BLOB5_COLUMN_MAP` and `_check_blob5_drift`**:
if the roles blob was genuinely reshaped, the column ordering may have moved
too, and loosening the detector alone risks writing a silently-shuffled
dataset.

## Blocker to be aware of

The session that diagnosed this had its egress proxy 403 `en.zona.media`,
`s3.zona.media`, and `pub-…r2.dev`, so the bundle and the prod DB could not be
fetched. Either run in an env with those domains allowed, or add the
blob-shape dump to the script and read it out of a CI run.
