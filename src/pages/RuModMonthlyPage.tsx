import { useEffect, useMemo, useState } from "react";
import { useRuModDatabaseContext } from "@/context/useRuModDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import type { RuAdMonthlyRow, MonthlyDataPoint } from "@/types";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

type MetricKey = "total" | "night" | "day";

export function RuModMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryDataWindow } = useRuModDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [allRows, setAllRows] = useState<RuAdMonthlyRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const yr = useMonthlyMonthRange(allRows.length);
  const rows = useMemo(() => yr.slice(allRows), [allRows, yr]);

  useEffect(() => {
    if (loadState === "ready") {
      setAllRows(queryMonthly());
      setHasData(true);
    }
  }, [loadState, queryMonthly, refreshKey]);

  const allStats = useMemo(() => {
    const keys: MetricKey[] = ["total", "night", "day"];
    const out: Record<string, { max: number; median: number; total: number }> = {};
    for (const k of keys) {
      out[k] = maxMedian(allRows.map((r) => (typeof r[k] === "number" ? r[k] : null)));
    }
    return out;
  }, [allRows]);

  const endMonth = resolvedEndMonth("Europe/Moscow");
  const makeDataset = (key: MetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
      rows.map((d) => {
        const value = d[key];
        const projected = d[`${key}_projected`];
        // Only the overall-total chart carries the double-count caveat (the flag is
        // about a report's whole window, not its night/day split).
        const note =
          key === "total" && d.overlap_reports > 0
            ? `includes ${d.overlap_reports} report${d.overlap_reports > 1 ? "s" : ""} whose window may overlap a neighbor — possible double-count`
            : undefined;
        return {
          date: d.date,
          value,
          gap: projected != null && value != null ? projected - value : undefined,
          projected,
          projection_day: d.projection_day ?? undefined,
          projection_days_in_month: d.projection_days_in_month ?? undefined,
          note,
        };
      }),
      endMonth,
    );

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexDirection: 'column', marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Monthly Ukrainian UAVs Downed - RU MoD
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Monthly sums of Russian MoD air-defense intercept claims (MSK drone-days). Current month shows an end-of-month projection. A dashed outline marks months containing a report whose window may overlap a neighbor (possible double-count) — see tooltip.
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-mod" />
      </div>
      <div className="page-controls-sticky" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        {!yr.hidden && (
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
        )}
        <StatScopeToggle />
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU air-defense database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          <MonthlyBarChart title="UAVs Downed — Monthly Total" data={makeDataset("total")} wfull
            globalMax={allStats.total?.max ?? 0} globalMedian={allStats.total?.median ?? 0} globalTotal={allStats.total?.total ?? 0} />
          <MonthlyBarChart title="Overnight Reports" data={makeDataset("night")} wfull={false}
            globalMax={allStats.night?.max ?? 0} globalMedian={allStats.night?.median ?? 0} globalTotal={allStats.night?.total ?? 0} />
          <MonthlyBarChart title="Daytime Reports" data={makeDataset("day")} wfull={false}
            globalMax={allStats.day?.max ?? 0} globalMedian={allStats.day?.median ?? 0} globalTotal={allStats.day?.total ?? 0} />
        </ChartGrid>
      )}
    </div>
  );
}
