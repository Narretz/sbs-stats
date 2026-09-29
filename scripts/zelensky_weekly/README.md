# President's weekly strike tally (`scripts/zelensky_weekly/`)

Builds **`data/zelensky-weekly.db`** from the President of Ukraine's Telegram
channel, [@V_Zelenskiy_official](https://t.me/V_Zelenskiy_official), read by
the site `zelensky-weekly` (`src/pages/ZelenskyWeeklyPage.tsx`) off the
`weekly` view.

Most Sundays one post closes with the week's Russian strikes on Ukraine:

```
За цей тиждень росіяни випустили по Україні понад 3170 ударних дронів,
більше 1300 КАБів і 74 ракети різних типів, із них більшість – балістичні.
```

Three counters, `drones` / `bombs` / `missiles`. **Why it's worth having:**
the bomb count (КАБ, guided aerial bombs) is the only regular official figure
for them. The Air Force data behind `ru-air-attacks-gsua` has none. The drone
and missile counts are a second, rounded official figure for weeks the Air
Force reports day by day, and they differ from its numbers.

```sh
# incremental: what CI runs; stops at the newest post already stored
python3 scripts/zelensky_weekly/ingest.py --out data/zelensky-weekly.db

# the whole history (~21k posts, ~1,100 preview pages, ~40 min)
python3 scripts/zelensky_weekly/ingest.py --out data/zelensky-weekly.db --backfill

# after a parser fix: re-read stored text (dry run; --apply writes)
python3 scripts/zelensky_weekly/ingest.py --out data/zelensky-weekly.db --reparse
```

Public `t.me/s` preview, stdlib only, no Telegram account. (The `V_Zelenskiy`
slug doesn't serve a usable preview.) CI:
`.github/workflows/update-zelensky-weekly-db.yml`, at 20:00 Kyiv time on
Saturday, Sunday and Monday, uploading only when something changed. An empty
R2 object is **not** rebuilt by CI. Seed it with a local `--backfill` and one
manual `wrangler r2 object put`.

## Reading the numbers

- **Every figure is rounded, and most are hedged.** `counters.bound` keeps the
  hedge: `at_least` (понад / більше / більш як), `at_most` (майже), `approx`
  (близько / приблизно), `exact` (a bare number, which is still usually
  round). Chart them as approximate.
- **The week is derived, never read.** Posts say "цього тижня" ("this week") or
  "минулого тижня" ("last week"). `week_bounds` maps a Saturday or Sunday post
  to its own ISO week, whichever wording it uses, because on a Sunday "last
  week" means the week ending that day. A Monday or Tuesday post maps to the
  week that just ended, and a Wednesday–Friday "last week" post to the
  previous ISO week. `period` is `YYYY-Www`, Monday to Sunday, Kyiv time.
- **A Wednesday–Friday "this week" is the week so far.** It's stored as
  `weekly_partial` and kept out of the `weekly` view.
- **A missing counter is NULL, not 0.** Single-weapon tallies are normal
  ("Лише за цей тиждень … близько 2100 дронів.").
- **The `weekly` view** gives one row per week. When a week has several
  tallies (the morning post, the evening address repeating it, a Monday
  recap, the English translation), the post naming the most weapons wins,
  then Ukrainian, then the latest.

## What the parser guards against

Each of these traps is a fixture in `test_parse.py`:

| Trap | Example | Handling |
|---|---|---|
| Nightly count in the sentence before | «Протягом цієї ночі … 103 шахеди. Всього впродовж цього тижня …» | scope is one sentence |
| Night and week in one sentence | «Минулої ночі … 50 дронами, а за тиждень … 900 бомбами» | count from the week clause |
| Week named, counted in the next sentence | «Протягом тижня під ударом … 1310 … бомб, …» | next sentence, needs ≥ 2 weapons |
| Shot down, not launched | «за цей тиждень Сили оборони збили … 33 ракети» | interception verb before the count → skip |
| Breakdown after a total | «99 ракет, зокрема 40 балістичних» | first number per weapon wins |
| Round words | «майже тисяча КАБів», «дев’ять ракет» | word table; «тисячі» only with a hedge; «сотні» never |
| Week so far / month so far | «Від початку тижня … за три доби», «За цей місяць» | not a tally |

When a tally names a weapon but the parser can't read its number, the ingest
raises a `zelensky-weekly: tally not fully read` annotation instead of silently
recording NULL.

## Coverage

Weekly tallies run from **mid-2024** onward (a one-off in March 2024).
Early posts often give bombs only. There are real gaps, not parser misses:
**April–June and July–September 2025** the President switched to
**month-to-date** tallies («Лише від початку квітня …», «За цей місяць …»),
which aren't parsed. That would be a separate series, if it's wanted.
