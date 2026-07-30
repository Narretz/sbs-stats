# Zircon: GUR stockpile vs. recorded attacks — reconciliation findings

Analysis dated **2026-07-30**. Cross-references the HUR/GUR missile-stockpile
dataset (`scripts/missile_stockpile/reports.json`, site `ru-missiles-hur`)
against the RU missile & UAV attacks dataset (piterfm →
`data/ru-air-attacks-gsua.db`, site `ru-air-attacks-gsua`). This is the
"consumption vs inventory" cross-check flagged as a TODO in `DATASETS.md` §9,
worked through for one type (Zircon / `3M22`) where both sides carry a clean,
non-aliased key.

Snapshot basis: attacks DB pulled 2026-07-21, max `time_start` = 2026-07-18.
Numbers below will shift as piterfm republishes; treat as a method + a
point-in-time result, not a live figure.

## The two series

**Stockpile (reports.json, standalone `zircon` measurements):**

| as_of | value | bound |
|---|---|---|
| 2025-12-01 | 200 | at_least (≥) |
| 2026-04-15 | 230 | up_to (≤) |
| 2026-07-15 | 120 | at_least (≥), "before the 2026-07-19 attack" |

Production: 2026 **annual** plan of 30 → ~2.5/month (bound = planned).

**Attacks (piterfm, model `3M22 Zircon`, `launched` = consumed):**

- Cumulative all-time: **56 launched / 20 destroyed**, 19 rows, 2024-03-25 → 2026-07-06 (standalone).
- 2026 by month (standalone launched): Jan 3, Feb 16, Mar 4, May 3, Jun 15, Jul 10.
- mid-Apr → mid-Jul (Apr 15 → Jul 15): **~28** launched (May 3 + Jun 15 + Jul[1–6] 10; zero in Jul 7–15).
- Since Dec 2025 → mid-Jul: **~51** launched.

**GUR usage context (from the 2026-07-18 disclosure):** 200+ missiles fired at
Ukraine since early June; **107 ballistic + 20 Zircon** in the first 19 days of July.

## Finding 1 — the Jul 18 bundle: category flip + attribution loss

`3M22 Zircon` is categorized **cruise** in every one of its 19 standalone rows.
On **2026-07-18** it appears only inside a bundle:

```
C-400 and Iskander-M and 3M22 Zircon | category=ballistic | launched=35 destroyed=17
```

This is the **only bundled-Zircon row in the entire dataset** (2024→2026-07-18),
and the only time Zircon lands in `ballistic` instead of `cruise`. Consequences:

- In `daily_by_category`, all 35 of Jul 18 count as ballistic; none as cruise.
- The bundle carries a single `launched`, so the Zircon share is **unsplittable**
  — the standalone `3M22 Zircon` series (56 cumulative, last Jul 6) excludes it.
- This closes GUR's "20 Zircon in 19 days" = **10 standalone (Jul 2+6) + ~10 buried
  in the Jul 18 bundle** (the other ~25 of 35 being C-400 / Iskander-M).

Note: the Jul 18 firing is *after* the mid-July (Jul 15, "before the July 19
attack") stockpile snapshot, so it draws down the ≥120 floor afterward — it is
NOT part of the mid-Apr→mid-Jul window.

## Finding 2 — the bound trap

The mid-April report is entirely **ceiling-framed** (`up_to`) and the mid-July
report **floor-framed** (`at_least`). Differencing them is invalid:

- Face-value drop: 230 − 120 = **110**.
- With a ±10 error margin taken inward: (230−10) − (120+10) = 220 − 130 = **90**.
- Recorded net drawdown, mid-Apr→mid-Jul: ~28 launched − ~7.5 produced ≈ **~20**.
- **Gap ≈ 70.**

This is exactly the `known_issues` caveat in reports.json: floor-vs-ceiling
framing manufactures fake volatility. A ceiling and a floor were never meant to
be subtracted.

## Finding 3 — the ~70 is NOT recoverable from the attacks data

Checked whether the missing ~70 could be unattributed strikes hiding in the DB:

- Generic buckets that *could* mask Zircon — `Ballistic Missile` (4 launched
  all-time) and `Intercontinental Ballistic Missile` (3 all-time) — total **7
  ever, and just 1 in the whole mid-Apr→mid-Jul window.** No reservoir there.
- In-window ballistic is fully named: `C-400 and Iskander-M` (216), `Iskander-M`
  (91), `Kinzhal` (8) — none plausibly Zircon.

So within the recorded dataset, in-window Zircon consumption is ~28, full stop.
The ~70 gap cannot be closed as "consumption we failed to attribute."

## Finding 4 — but the record itself is a floor, not a ceiling (AFU underreporting)

piterfm's source is the **UA Air Force Command air-raid notes (kpszsu)**, which
undercount launches by construction:

- Hypersonic/ballistic is hardest to tally; AFU summaries lean toward what air
  defense **engaged/intercepted**. Unintercepted fast missiles, or strikes on
  front-line / regional targets outside headline raids, can be **absent
  entirely** (not miscategorized — so Finding 3's bucket check can't see them).
- The Jul 18 bundle is direct evidence of under-attribution even in a
  well-covered window: GUR says ~20 Zircon, piterfm shows 10 standalone + an
  unsplittable bundle.

So **~28 is a floor on Zircon consumption, not a ceiling** — real usage ≥ 28,
plausibly higher.

Proportionality caveat: Zircon is among the **more-reported** types (rare,
~$6M/launch, individually newsworthy), so its underreporting is likely milder
than for the general missile stream. This lifts 28 toward maybe 40–60; reaching
~90 would still need the loose-bounds effect doing much of the work.

## Verdict

The ~70 gap is **real as arithmetic on the bounds**, but it is **underdetermined**
— the attacks data cannot close it in either direction. Best read as a mix of:

1. **Soft, incomparable bounds** (ceiling ≤230 vs floor ≥120 can't be differenced);
2. **AFU launch-underreporting** (confirmed launches are a lower bound);
3. **Estimate / attrition noise** (HUR methodology revisions — its own reports
   disagree weeks apart — plus test failures / scrapping that never appear as a launch).

None must carry all 70 alone; they stack. The true drawdown sits somewhere
between the **~20** the record shows and the **~90** the bounds suggest.

## Implications for a consumption-vs-inventory view (§9)

- The standalone `3M22 Zircon` series **undercounts** — treat launched as a floor.
- Don't use `daily_by_category` to isolate Zircon: it's cruise everywhere except
  the single Jul 18 ballistic bundle, so category totals are both incomplete and
  misfiled there.
- Any join to the stockpile `zircon` type must treat the Jul 18 bundle as a
  `combined` upper bound (≤35), never a Zircon count.
- When overlaying, render stockpile points at their **bound** (≤ / ≥ / ~), never
  as a line implying a differenced count.
