# Writing tests

Which tier a case belongs in: [CLAUDE.md](CLAUDE.md) → Tests. This is how to
write one there, and how to move one between tiers.

## Unit (`src/**/*.test.ts`)

- **Lift, then test.** Logic inside a component or hook (a `useMemo` deciding
  what a row says, a `useCallback` around a query) moves into a plain module
  that takes its inputs as arguments; the component or hook keeps the state
  and calls it. Precedents: `compare/registry.ts` (`comparableSet`,
  `parseColumns`), `data/ruAirAttacksDb.ts` (every query, a function of a
  `Database`), `utils/zelenskyWeekly.ts` (`weekNote`, a tooltip's lines as
  strings).
- **SQL runs for real.** Seed an in-memory sql.js with the source's schema and
  only the rows the cases need, then call the real query
  (`data/ruAirAttacksDb.test.ts`, `utils/airAttacksSql.test.ts`). Mirror the
  e2e fixture's cases rather than importing `e2e/build-fixtures.mjs`.
- **Assert the guarantee, not one dataset's outcome.** "Never exceeds the
  total" on fixture values became "no counter is counted twice" over the
  registry. That holds for every input and fails at the cause.

## Browser (`src/**/*.browser.test.tsx`)

- **The shell.** A chart that pins needs `RouteProvider` + `ChartPinProvider`,
  with `<ChartSheet />` beside it, and `import "@/styles/theme.css"` for any
  layout, CSS or container-query case. Copy `Shell` from
  `ChartSheet.browser.test.tsx`.
- **Synthetic props shaped like the real ones**, and only as many as the case
  needs. A hover card's descriptor shaped unlike the real one tests a card
  nobody sees.
- **Layout is measurable.** `page.viewport(w, h)` drives media queries (reset
  it in `afterEach`); a wrapper `<div style={{ width }}>` drives container
  queries; `getComputedStyle(el, "::after")` reads generated content.
- **Gotchas:**
  - `render()` keeps earlier mounts. A case that mounts twice must
    `await unmount()` the first, or its queries find the old one.
  - recharts re-renders on hover: look elements up again after each move,
    and hover the `svg.recharts-surface` at a position rather than a bar's
    `<path>`.
  - recharts raises its tooltip on mousemove: sweep a few pixels
    (`hover` in `ChartSheet.browser.test.tsx`).
  - The hourly chart finds "today" by Kyiv's real date
    (`getKyivDateString()`), not by `is_today`. Synthetic days end on it.

## e2e (`e2e/*.spec.ts`)

- **One case per wiring path**, asserting that the thing reached the screen.
  The rule's edge cases stay in the tier below, with a comment pointing there.
- **Poll, don't read once.** Tables and charts render before their DB
  resolves, and sub-unit data arrives later still.
- Cases on one page share its load. Merge them rather than load it twice.

## Moving a test down a tier

1. Write the new test and see it pass.
2. **Mutation-check it.** Reintroduce the bug it guards against (back the file
   up, edit, run, restore) and see it go red. A moved test that
   stays green against the bug guards nothing.
3. Delete or slim the e2e case. Leave a one-line comment where it was naming
   the test that replaced it. Keep whatever part of it was wiring.
4. Run the e2e specs you touched. The pre-push hook runs the rest.
