import { useEffect, useMemo, useState } from "react";
import { useSbuAlfaDatabaseContext } from "@/context/useSbuAlfaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyYearRange } from "@/hooks/useMonthlyYearRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { TargetsStackedChart, type TargetsStackPoint } from "@/components/TargetsStackedChart";
import { YearRangeSelect } from "@/components/YearRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { extendMonthsTo, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import {
  SBU_ALFA_CATEGORY_KEYS,
  SBU_ALFA_CATEGORY_LABELS,
  type MonthlyDataPoint,
  type SbuAlfaCategoryKey,
  type SbuAlfaCounterRow,
} from "@/types";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

// Counter rows → one MonthlyDataPoint per period present, in ascending order.
// The bound qualifier becomes a chart tooltip "note" so the reader sees that
// "понад 8 000" means the value is a floor ("≥") rather than a precise count.
function toDataset(
  rows: SbuAlfaCounterRow[],
  category: SbuAlfaCategoryKey,
  periods: string[]
): MonthlyDataPoint[] {
  const byPeriod = new Map(rows.filter((r) => r.category === category).map((r) => [r.period, r]));
  return periods.map((period) => {
    const r = byPeriod.get(period);
    const value = r ? r.value : null;
    let note: string | undefined;
    if (r) {
      if (r.derived) {
        note = r.derivation_note ?? "Derived from other counters (not stated by SBU).";
      } else if (r.bound === "at_least") {
        note = `Self-reported floor (понад / "over") — actual may be higher. Source phrasing: "${r.raw_label ?? ""}"`;
      } else if (r.bound === "approx") {
        note = `Approximate ("близько / приблизно ~"). Source phrasing: "${r.raw_label ?? ""}"`;
      } else if (r.bound === "up_to") {
        note = `Ceiling ("до" / "up to"). Source phrasing: "${r.raw_label ?? ""}"`;
      }
    }
    return { date: period, value, note };
  });
}

export function SbuAlfaMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryCounters, queryDataWindow } = useSbuAlfaDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [rows, setRows] = useState<SbuAlfaCounterRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryCounters());
      setHasData(true);
    }
  }, [loadState, queryCounters, refreshKey]);

  // Distinct periods (months) in ascending order — drives the x-axis of every
  // chart so months align even when categories are sparse (e.g. air_defense
  // missing in March).
  const allPeriods = useMemo(() => {
    const set = new Set(rows.map((r) => r.period));
    return Array.from(set).sort();
  }, [rows]);

  // Time-window picker. The hook auto-hides when there are ≤12 periods, so this
  // is a no-op today (3 months) and the picker appears automatically once SBU
  // has published 13+ monthly recaps.
  const yr = useMonthlyYearRange(allPeriods.length);
  const periods = useMemo(
    () => extendMonthsTo(yr.slice(allPeriods), resolvedEndMonth()),
    [allPeriods, yr],
  );
  const visibleRows = useMemo(() => {
    if (yr.hidden) return rows;
    const keep = new Set(periods);
    return rows.filter((r) => keep.has(r.period));
  }, [rows, periods, yr.hidden]);

  // Only render charts for categories that have at least one observation in the
  // visible window — skip the empty ones so the page isn't cluttered with blank
  // cards. The three targets_* categories are folded into one stacked chart
  // below, so exclude them from the per-category grid.
  const presentCategories = useMemo(() => {
    const seen = new Set(visibleRows.map((r) => r.category));
    return SBU_ALFA_CATEGORY_KEYS.filter(
      (k) => seen.has(k) && k !== "targets_total" && k !== "targets_destroyed" && k !== "targets_damaged"
    );
  }, [visibleRows]);

  // Build the destroyed/damaged stack. `total` is included for the tooltip;
  // by SBU's own phrasing total = destroyed + damaged, so the bar height also
  // shows the total.
  const targetsStack: TargetsStackPoint[] = useMemo(() => {
    const get = (period: string, cat: SbuAlfaCategoryKey): number | null => {
      const r = visibleRows.find((x) => x.period === period && x.category === cat);
      return r ? r.value : null;
    };
    return periods.map((period) => ({
      date: period,
      destroyed: get(period, "targets_destroyed"),
      damaged: get(period, "targets_damaged"),
      total: get(period, "targets_total"),
    }));
  }, [visibleRows, periods]);
  const hasTargetsData = targetsStack.some((p) => p.destroyed != null || p.damaged != null);

  // Whole-dataset stats per category, from the un-sliced `rows` so the "all"
  // stat scope reflects every published month — not just the picker window.
  const allStats = useMemo(() => {
    const out: Record<string, { max: number; median: number; total: number }> = {};
    for (const k of SBU_ALFA_CATEGORY_KEYS) {
      out[k] = maxMedian(
        rows.filter((r) => r.category === k).map((r) => r.value),
      );
    }
    return out;
  }, [rows]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexDirection: 'column', marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          SBU «Альфа» — Monthly Recap
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3, maxWidth: 900, lineHeight: 1.55 }}>
          Targets the Centre of Special Operations «А» (SBU «Альфа») reports having struck each month, from their
          {" "}
          <a href="https://ssu.gov.ua/novyny" rel="nofollow external">SBU press releases</a>.
          {" "}
          KIA is always given as a floor ("понад N") — see the tooltip "Self-reported floor" note. All other counters are bare numbers.
          {" "}
        </p>
        {dataWindow.minPeriod && dataWindow.maxPeriod && (
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 6 }}>
            Data Availability: {dataWindow.minPeriod} – {dataWindow.maxPeriod} · {allPeriods.length} month{allPeriods.length === 1 ? "" : "s"}
          </p>
        )}
      </div>
      <div className="page-controls-sticky" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        {!yr.hidden && (
          <YearRangeSelect options={yr.yearOptions} value={yr.years} onChange={yr.setYears} />
        )}
        <StatScopeToggle />
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading SBU Alfa database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {hasTargetsData && (
            <TargetsStackedChart
              title="Other targets — destroyed + damaged"
              data={targetsStack}
              wfull
            />
          )}
          {presentCategories.map((k) => (
            <MonthlyBarChart
              key={k}
              title={SBU_ALFA_CATEGORY_LABELS[k]}
              data={toDataset(visibleRows, k, periods)}
              wfull={false}
              globalMax={allStats[k]?.max ?? 0}
              globalMedian={allStats[k]?.median ?? 0}
              globalTotal={allStats[k]?.total ?? 0}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
