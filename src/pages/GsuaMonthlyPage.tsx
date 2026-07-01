import { useEffect, useMemo, useState } from "react";
import { useGsuaDatabaseContext } from "@/context/useGsuaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyYearRange } from "@/hooks/useMonthlyYearRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DirectionCoverageChart } from "@/components/DirectionCoverageChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { YearRangeSelect } from "@/components/YearRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import {
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  type GsuaMetricKey,
  type GsuaMonthlyRow,
  type GsuaDirectionCoverageRow,
  type MonthlyDataPoint,
} from "@/types";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

export function GsuaMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryDirectionCoverageMonthly, queryDataWindow } = useGsuaDatabaseContext();
  const [dataWindow, setDataWindow] = useState<{ minDate: string | null; maxDate: string | null; latestSnapshotAt: string | null }>({ minDate: null, maxDate: null, latestSnapshotAt: null });
  useEffect(() => { queryDataWindow().then(setDataWindow); }, [queryDataWindow]);
  const [allRows, setAllRows] = useState<GsuaMonthlyRow[]>([]);
  const [coverageRows, setCoverageRows] = useState<GsuaDirectionCoverageRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const yr = useMonthlyYearRange(allRows.length);
  const rows = useMemo(() => yr.slice(allRows), [allRows, yr]);

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const [monthly, coverage] = await Promise.all([
        queryMonthly(),
        queryDirectionCoverageMonthly(),
      ]);
      if (cancelled) return;
      setAllRows(monthly);
      setCoverageRows(coverage);
      setHasData(true);
    })();
    return () => { cancelled = true; };
  }, [loadState, queryMonthly, queryDirectionCoverageMonthly, refreshKey]);

  // Coverage rows are keyed by "YYYY-MM"; filter to the same year-range slice
  // the metric grid uses so the two views agree on what's shown.
  const filteredCoverageRows = useMemo(() => {
    if (rows.length === 0) return coverageRows;
    const months = new Set(rows.map((r) => r.date));
    return coverageRows.filter((r) => months.has(r.date));
  }, [coverageRows, rows]);

  // Whole-dataset stats per metric, from un-sliced rows so the "all" stat
  // scope reflects the full history (not just the year-range window).
  const allStats = useMemo(() => {
    const out: Record<string, { max: number; median: number; total: number }> = {};
    for (const k of GSUA_METRIC_KEYS) {
      out[k] = maxMedian(allRows.map((r) => (typeof r[k] === "number" ? r[k] : null)));
    }
    return out;
  }, [allRows]);

  const endMonth = resolvedEndMonth();
  const makeDataset = (key: GsuaMetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
      rows.map((d) => {
        const value = typeof d[key] === "number" ? d[key] : null;
        const projected = d[`${key}_projected`];
        return {
          date: d.date,
          value,
          gap: projected != null && value != null ? projected - value : undefined,
          projected,
          projection_day: d.projection_day ?? undefined,
          projection_days_in_month: d.projection_days_in_month ?? undefined,
        };
      }),
      endMonth,
    );

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexDirection: 'column', marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Monthly Combat Stats - GSUA
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Monthly sums of daily totals from Ukrainian General Staff reports. Current month shows end-of-month projection.  Via Telegram @GeneralStaffZSU.
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="gsua" latestSnapshotAt={dataWindow.latestSnapshotAt} />
      </div>
      <div className="page-controls-sticky" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        {!yr.hidden && (
          <YearRangeSelect options={yr.yearOptions} value={yr.years} onChange={yr.setYears} />
        )}
        <StatScopeToggle />
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading GSUA database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {GSUA_METRIC_KEYS.map((k) => (
            <MonthlyBarChart
              key={k}
              title={GSUA_METRIC_LABELS[k]}
              data={makeDataset(k)}
              wfull={k === "combat_engagements"}
              globalMax={allStats[k]?.max ?? 0}
              globalMedian={allStats[k]?.median ?? 0}
              globalTotal={allStats[k]?.total ?? 0}
            />
          ))}
          {filteredCoverageRows.length > 0 && (
            <DirectionCoverageChart
              data={filteredCoverageRows}
              wfull
              granularity="monthly"
            />
          )}
        </ChartGrid>
      )}
    </div>
  );
}
