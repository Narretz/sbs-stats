# Body exchanges (UA+RU)

Repatriations of fallen soldiers' bodies between Russia and Ukraine, one record
per exchange, in [`exchanges.json`](exchanges.json). The site `body-exchanges`
imports the file directly (`src/data/bodyExchanges.ts`) and bundles it at build
time, like the HUR missiles view: no ingest, no DB, no R2 object. Editing the
file and deploying is the whole pipeline.

## Sources

Each side announces its own count, and they are not always the same number:

- **Bodies received by Ukraine** — the Coordination HQ for the Treatment of
  POWs, [t.me/Koord_shtab](https://t.me/Koord_shtab). Its public preview
  (`t.me/s/Koord_shtab`, searchable with `?q=`) needs no login. In 2023 some
  returns were announced by the Ministry of Reintegration's missing-persons
  commissioner instead.
- **Bodies received by Russia** — Russian officials as quoted by
  [RBC](https://www.rbc.ru): Duma deputy Shamsail Saraliev for most exchanges,
  presidential aide Vladimir Medinsky for the Istanbul-agreement ones. rbc.ru
  answers scripted requests with 401; its AMP pages
  (`amp.rbc.ru/rbcnews/politics/DD/MM/YYYY/<id>`) don't. Searching rbc.ru for
  `тела погибших` or `Саралиев` in a date window finds the articles.

Russia often gave no figure in 2023; `ru_received` is then `null` (unknown),
which is not 0 — the one-way transfers of June 2025 are real 0s.

## Adding an exchange

Append a record (the file is kept in date order) with each figure, who reported
it, and a source per figure carrying a short verbatim `quote`. `status` is
`confirmed`, `partial` (one side's figure unknown) or `discrepancy` (sources
disagree with each other on a figure — explain in `notes`; a later article
misremembering an exchange doesn't count). `src/data/bodyExchanges.test.ts`
checks the order and that every stated figure has a source covering it.

## Backfill

Seeded from a chart by the OSINT account creamy_caprice
(`sources/body-exchanges.png`, May 2023 – Oct 2026, no sources given), then
checked exchange by exchange against RBC and the Coordination HQ's posts. The
chart's values stay in `chart_creamy_caprice` for audit, and how it differs in
`chart_creamy_caprice_discrepancy` — it dates one exchange wrongly, misses six,
and cuts off five labels. Open items are in the file's `_doc.todo`.
