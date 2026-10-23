# Prisoner exchanges (UA+RU)

People returned from captivity between Russia and Ukraine — soldiers and
civilians — one record per day of returns, in [`exchanges.json`](exchanges.json).
The site `pow-exchanges` imports the file directly (`src/data/powExchanges.ts`)
and bundles it at build time, like the [body exchanges](../body_exchanges/README.md):
no ingest, no DB, no R2 object. Editing the file and deploying is the whole
pipeline.

## Sources

Each side announces its own count:

- **Returned to Ukraine** — the Coordination HQ for the Treatment of POWs,
  [t.me/Koord_shtab](https://t.me/Koord_shtab) (public preview
  `t.me/s/Koord_shtab`, no login). Its posts give soldiers and civilians
  separately, and since 2024 most number the exchange ("76-й обмін
  полоненими"), kept in `koord_number`. Before the channel's first post
  (2022-07-21) they come from Deputy PM Iryna Vereshchuk's
  (t.me/vereshchuk_iryna) and GUR's (t.me/DIUkraine) Telegram posts.
- **Returned to Russia** — the Russian Ministry of Defence,
  [t.me/mod_russia](https://t.me/mod_russia): "возвращены N российских
  военнослужащих. Взамен переданы N военнопленных ВСУ". The public preview's
  search shows only the latest ~20 hits per query, so use the Telegram API
  (the session in `.env.telegram` / `scripts/gsua`): its search pages through
  every hit. Some exchanges the MoD never announced at all — Russia's figure
  stays `null` there.

When Ukraine gave no count — most of the Istanbul stages of June–August 2025
were announced only as "a group" — `ua_received` is Russia's "взамен
переданы N" and `ua_reported_by` says so. Figures that aren't known stay
`null` (unknown), which is not 0.

## Backfill

From September 2022 the record is the two channels, end to end: the
Coordination HQ channel was archived in full through its public preview, and
the MoD's announcements found through the Telegram API (`search` for the
exchange wording, then each exchange day read whole for the ones the search
missed). March–June 2022, before the HQ channel, comes from Deputy PM Iryna
Vereshchuk's and GUR's Telegram posts for Ukraine's figures and Russian
officials quoted by Interfax / RIA for Russia's. No exchange took place in
July–August 2022. The known gaps are in the file's `_doc.todo`.

## What counts

- A record is a day on which people held by one side were returned to the
  other, or a one-way release (`kind: "release"`): the seriously wounded
  handed over outside an exchange, say. A deal carried out in stages (Istanbul
  2025, Geneva 2026, "1000 for 1000" 2026) is one record per stage, tied by
  `deal`.
- Counts include civilians; how many were civilians is in
  `ua_received_civilians` / `ru_received_civilians` when the side said.
- Bodies of the dead are not here — they are the body exchanges.
- Returns of Ukrainians held by Belarus on Belarusian charges (Nov 2025) are
  not exchanges with Russia and are left out; soldiers returned from Russian
  captivity *via* Belarus are in.

## Adding an exchange

Append a record (the file is kept in date order) with each figure, who
reported it, and a source per figure carrying a short verbatim `quote`.
`status` is `confirmed`, `partial` (one side's figure unknown) or
`discrepancy` (sources disagree on a figure — explain in `notes`).
`src/data/powExchanges.test.ts` checks the order and that every stated figure
has a source covering it.
