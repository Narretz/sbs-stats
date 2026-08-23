import { useEffect, useMemo, useState } from "react";
import { useGsuaDatabaseContext } from "@/context/databases";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DirectionCoverageChart } from "@/components/DirectionCoverageChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
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

interface Props {
  refreshKey?: number;
}

export function GsuaMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryMonthly, queryDirectionCoverageMonthly, queryDataWindow } = useGsuaDatabaseContext();
  const [dataWindow, setDataWindow] = useState<{ minDate: string | null; maxDate: string | null; latestSnapshotAt: string | null }>({ minDate: null, maxDate: null, latestSnapshotAt: null });
  useEffect(() => { queryDataWindow().then(setDataWindow); }, [queryDataWindow]);
  const [allRows, setAllRows] = useState<GsuaMonthlyRow[]>([]);
  const [coverageRows, setCoverageRows] = useState<GsuaDirectionCoverageRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const yr = useMonthlyMonthRange(allRows.length);
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
    <PageScaffold
      title="Monthly Combat Stats - GSUA"
      description="Monthly sums of daily totals from Ukrainian General Staff reports. Current month shows end-of-month projection. Parsed deterministically from Telegram @GeneralStaffZSU. May be incomplete or incorrect."
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="gsua" latestSnapshotAt={dataWindow.latestSnapshotAt} />}
      controls={<>
        {!yr.hidden && (
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
        )}
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading GSUA database…"
      gridChildren={<>
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
      </>}
    />
  );
}
