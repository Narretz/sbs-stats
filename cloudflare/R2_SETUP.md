# R2 bucket setup for sbs.db

One-time setup so the GHA `Upload DB to R2` step in
`.github/workflows/update-db.yml` can publish `data/sbs.db` to a
browser-fetchable R2 URL.

Run these commands locally (you'll need a wrangler login to your CF
account once — `wrangler login` opens a browser).

## 1. Create the bucket

```sh
wrangler r2 bucket create russia-ukraine-war
```

## 2. Apply the CORS rules

```sh
wrangler r2 bucket cors put russia-ukraine-war --file=r2-cors.json
```

The rules in `r2-cors.json` allow `GET` / `HEAD` from
`https://narretz.github.io` (Pages production) and
`http://localhost:5173` (Vite dev). Add origins for any other
deploy targets you use.

## 3. Enable the public r2.dev URL

```sh
wrangler r2 bucket dev-url enable russia-ukraine-war
```

This prints a `https://pub-<hash>.r2.dev` URL. The DB will be at
`https://pub-<hash>.r2.dev/sbs.db` once the workflow has run.

## 4. Create the API token for GHA

In the Cloudflare dashboard: **My Profile → API Tokens → Create
Token → Custom token**.

- Name: `sbs-stats GHA R2 upload`
- Permissions: `Account → Workers R2 Storage → Edit`
- Account resources: include your account
- (Optional but recommended) Token TTL: rotate yearly

Copy the token value.

## 5. Add the GHA secrets

In the GitHub repo: **Settings → Secrets and variables → Actions →
New repository secret**.

- `CLOUDFLARE_API_TOKEN` — the token from step 4
- `CLOUDFLARE_ACCOUNT_ID` — found on the right sidebar of the CF
  dashboard home

## 6. Point the frontend at the new URL

Edit `.env.production` to:

```
VITE_DB_URL=https://pub-<hash>.r2.dev/sbs.db
```

After that's pushed and Pages redeploys, the frontend will load SBS
data from R2 instead of `raw.githubusercontent.com`. The repo commit
and Release upload still happen in parallel until you choose to
disable them.
