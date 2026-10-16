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

## Compress the DB downloads (serve R2 through Cloudflare's edge)

The public `r2.dev` URL serves every DB uncompressed, and Cloudflare calls it
rate-limited and not meant for production. gzip would shrink the whole-fetched
DBs 3–8× (sbs 2.3 → 0.69 MB, cit-civilians.app 2.3 → 0.43 MB,
ru-air-attacks-gsua 2.0 → 0.45 MB, ua-losses 1.9 → 0.27 MB); brotli a bit more.
Compressing on the way out keeps the stored objects plain SQLite, so wrangler,
`curl`, CI's pre-ingest download and `fetch_prod_dbs.sh` are untouched — the
repo change is only the `VITE_*_DB_URL` values in `.env.production`.

An R2 custom domain needs a domain whose DNS is a Cloudflare zone in the same
account. Keeping DNS elsewhere for just a subdomain (partial/CNAME setup,
subdomain zones) is Business/Enterprise only. Options:

1. **Move the existing domain's DNS to Cloudflare** (free; only the
   nameservers change, the registration stays). Check the imported records,
   mail included.
2. **Buy a separate cheap domain at Cloudflare Registrar** (at cost, ~$10/yr
   for a .com) used only for the data. Cleanest if the main domain stays put.
   **Preferred**, or 1.
3. **A Worker in front of the bucket on `workers.dev`** — no domain. Reads via
   an R2 binding, compresses itself (the runtime encodes per the response's
   `Content-Encoding`), passes byte ranges through, sets CORS. But the free
   plan's 100k requests/day counts every range request (dozens per GSUA page
   load), so it likely wants the $5/month plan, and it's code to maintain.

With 1 or 2: bucket → Settings → Custom Domains (e.g. `data.<domain>`), then a
Compression Rule for that hostname and `application/vnd.sqlite3` (not on
Cloudflare's default compressible list).

### Action

- [ ] Pick 1, 2 or 3; set up the custom domain (or Worker).
- [ ] Add the Compression Rule; verify with one object before switching any URL:
  - [ ] compressed: `curl -sI -H 'Accept-Encoding: br, gzip' https://data.<domain>/mediazona.db` shows `content-encoding` (unverified that the rule applies to R2-backed responses)
  - [ ] ranges still work: `curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-4095' https://data.<domain>/ru-attacks-gsua.app.db` → `206`
  - [ ] no edge caching of the DBs (`.db` isn't on the default cache list; no cache rule)
  - [ ] CORS headers present on the new hostname (R2's CORS policy is per bucket)
- [ ] Switch every `VITE_*_DB_URL` in `.env.production` in one commit.
