# TODO

## Backfill missing daily_stats from Telegram

Current `daily_stats` coverage: 2025-10-26 → present. Missing everything before 2025-10-26.
`monthly_stats` goes back to 2025-06-01, so monthly aggregates exist for that earlier window — just no daily granularity.

### Candidate sources

- **t.me/usf_army** — official SBS channel. Daily reports started ~late June 2025 (matches `monthly_stats` start). Format: "Протягом доби підрозділами угруповання Сил безпілотних систем уражено/знищено N цілей противника", with breakdowns for personnel, drone launch points, EW, vehicles, motos/buggies, copters, fixed-wing UAVs. Primary candidate for backfill.
- **t.me/robert_magyar** — Magyar's personal channel (USF commander). Reposts/comments on the same SBS-wide numbers. Cross-check source.
- **t.me/sbsarmy** — backup mirror, redirects to `usf_army`. Skip.
- **t.me/magyarbirds414** — 414th brigade only, NOT SBS-wide aggregate. Not usable for filling the SBS totals.

### Caveats

- Telegram daily reports cover only a **subset** of the 40 hit/destroyed categories in `daily_stats`. Backfilled rows will have many NULL columns vs. post-2025-10-26 rows.
- Pre-late-June-2025 daily data likely does not exist anywhere public — SBS started publishing only then.
- `t.me/s/usf_army` web preview supports pagination via `?before=<msg_id>` for scraping without API auth.

### Action

- [ ] Write scraper for `t.me/s/usf_army` to extract daily-report posts from ~2025-06-25 → 2025-10-25.
- [ ] Map Telegram report fields → `daily_stats` columns; document which columns will be NULL.
- [ ] Insert with `hour = 23` (or a sentinel) since Telegram posts are end-of-day aggregates, not hourly.
