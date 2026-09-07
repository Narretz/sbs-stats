import { useEffect, useMemo, useState } from "react";
import { useRubikonDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { extendMonthsTo, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import {
  RUBIKON_CATEGORY_KEYS,
  RUBIKON_CATEGORY_LABELS,
  RUBIKON_EW_KEY,
  RUBIKON_SORTIES_KEY,
  type MonthlyDataPoint,
  type RubikonCategoryKey,
  type RubikonCounterRow,
} from "@/types";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

const CHANNEL_URL = "https://t.me/icpbtrubicon";

// EW suppression carries a permanent caveat note, which MonthlyBarChart
// renders as a dashed-outline bar plus a "⚠" tooltip footer — the same
// treatment the other pages use for "this number doesn't mean what the
// neighbouring numbers mean".
//
// It earns that marking: 2 000–7 000 drones a month are reported as *jammed*
// («подавлено системами РЭБ»), which dwarfs most engaged categories. Un-marked
// next to the targets grid it would read as the unit's biggest kill count.
// Combat sorties get no note — the chart title already says what they are.
const KIND_NOTES: Partial<Record<RubikonCategoryKey, string>> = {
  [RUBIKON_EW_KEY]:
    "Electronic-warfare SUPPRESSION («подавлено системами РЭБ») — drones jammed, not struck. Rubikon reports this separately from its «Поражены» (targets engaged) list, and it is NOT included in any of them.",
};

// Counter rows → one MonthlyDataPoint per period, in the x-axis order the page
// computed. A month with no row for this category yields a null (empty bar) —
// sparse categories like ATGMs or SAMs appear only in the months the unit hit
// one, and absence is genuinely "not reported", not zero.
function toDataset(
  rows: RubikonCounterRow[],
  category: RubikonCategoryKey,
  periods: string[]
): MonthlyDataPoint[] {
  const byPeriod = new Map(rows.filter((r) => r.category === category).map((r) => [r.period, r]));
  const kindNote = KIND_NOTES[category];
  return periods.map((period) => {
    const r = byPeriod.get(period);
    if (!r) return { date: period, value: null, note: kindNote };
    const note = kindNote
      ? `${kindNote} Source phrasing: "${r.raw_label ?? ""}"`
      : undefined;
    return { date: period, value: r.value, note };
  });
}

export function RubikonMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryCounters, queryDataWindow } = useRubikonDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [rows, setRows] = useState<RubikonCounterRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryCounters());
      setHasData(true);
    }
  }, [loadState, queryCounters, refreshKey]);

  // Distinct months in ascending order — drives every chart's x-axis so the
  // months line up across cards even where a category is sparse.
  const allPeriods = useMemo(() => {
    const set = new Set(rows.map((r) => r.period));
    return Array.from(set).sort();
  }, [rows]);

  // Time-window picker; the hook hides itself at ≤12 periods, so it stays out
  // of the way until the series is over a year long.
  const yr = useMonthlyMonthRange(allPeriods.length, "all");
  const periods = useMemo(
    () => extendMonthsTo(yr.slice(allPeriods), resolvedEndMonth()),
    [allPeriods, yr],
  );
  const visibleRows = useMemo(() => {
    if (yr.hidden) return rows;
    const keep = new Set(periods);
    return rows.filter((r) => keep.has(r.period));
  }, [rows, periods, yr.hidden]);

  // Only chart categories with at least one observation in the visible window,
  // so the grid isn't padded with blank cards. Sorties and EW suppression are
  // rendered above the grid, in their own cards — excluded here.
  const presentCategories = useMemo(() => {
    const seen = new Set(visibleRows.map((r) => r.category));
    return RUBIKON_CATEGORY_KEYS.filter(
      (k) => seen.has(k) && k !== RUBIKON_SORTIES_KEY && k !== RUBIKON_EW_KEY,
    );
  }, [visibleRows]);

  const hasSorties = visibleRows.some((r) => r.category === RUBIKON_SORTIES_KEY);
  const hasEw = visibleRows.some((r) => r.category === RUBIKON_EW_KEY);

  // Whole-dataset stats per category, from the un-sliced `rows` so the "all"
  // stat scope reflects every published recap, not just the picker window.
  const allStats = useMemo(() => {
    const out: Record<string, { max: number; median: number; total: number }> = {};
    for (const k of RUBIKON_CATEGORY_KEYS) {
      out[k] = maxMedian(rows.filter((r) => r.category === k).map((r) => r.value));
    }
    return out;
  }, [rows]);

  // Source list for the disclosures panel — one entry per recap, linking back
  // to the Telegram post it was parsed from. Every recap has counters, so
  // deriving it from the counter rows covers them all.
  const reports = useMemo(() => {
    const byPeriod = new Map<string, { period: string; posted_at: string; url: string }>();
    for (const r of rows) {
      if (!byPeriod.has(r.period)) {
        byPeriod.set(r.period, { period: r.period, posted_at: r.posted_at, url: r.url });
      }
    }
    return Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
  }, [rows]);

  const chartFor = (k: RubikonCategoryKey, wfull: boolean) => (
    <MonthlyBarChart
      key={k}
      title={RUBIKON_CATEGORY_LABELS[k]}
      data={toDataset(visibleRows, k, periods)}
      wfull={wfull}
      globalMax={allStats[k]?.max ?? 0}
      globalMedian={allStats[k]?.median ?? 0}
      globalTotal={allStats[k]?.total ?? 0}
    />
  );

  return (
    <PageScaffold
      title="«Рубикон» — Monthly Recap"
      descriptionStyle={{ maxWidth: 900, lineHeight: 1.55 }}
      description={<>
        Targets the Russian UAV unit Центр «Рубикон» reports having engaged each month, from its
        {" "}
        <a href={CHANNEL_URL} rel="nofollow external">Telegram channel</a>.
        {" "}
        The unit reports «Поражены» — <em>engaged</em> — with no destroyed / damaged split, so each
        category is a single self-reported claim. The two charts at the top are <strong>not</strong>{" "}
        target counts: combat sorties are activity, and the EW figure counts drones{" "}
        <strong>jammed</strong>, not struck.
      </>}
      dataWindow={dataWindow.minPeriod && dataWindow.maxPeriod ? (
        <details style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 6 }}>
          <summary style={{ cursor: "pointer", listStyle: "revert" }}>
            Data Availability: {dataWindow.minPeriod} – {dataWindow.maxPeriod} · {allPeriods.length} recap{allPeriods.length === 1 ? "" : "s"}
          </summary>
          <ol style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
            {reports.map((r, i) => (
              <li key={r.period} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ color: t.textFaint, minWidth: 24 }}>[{i + 1}]</span>
                <span style={{ color: t.text, minWidth: 70 }}>{r.period}</span>
                <span style={{ flex: 1 }}>
                  Telegram post
                  <span style={{ color: t.textFaint }}> · posted {r.posted_at.slice(0, 10)}</span>
                  {" · "}
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    style={{ color: t.primary, textDecoration: "underline" }}
                  >
                    source ↗
                  </a>
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : undefined}
      controls={<>
        {!yr.hidden && (
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
        )}
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading Rubikon database…"
      gridChildren={<>
        {hasSorties && chartFor(RUBIKON_SORTIES_KEY, true)}
        {hasEw && chartFor(RUBIKON_EW_KEY, true)}
        {presentCategories.map((k) => chartFor(k, false))}
      </>}
    />
  );
}
