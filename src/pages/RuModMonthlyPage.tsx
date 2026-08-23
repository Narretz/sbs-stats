import { useEffect, useMemo, useState } from "react";
import { useRuModDatabaseContext } from "@/context/databases";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import type { RuAdMonthlyRow, MonthlyDataPoint } from "@/types";

interface Props {
  refreshKey?: number;
}

type MetricKey = "total" | "night" | "day";

export function RuModMonthlyPage({ refreshKey }: Props) {
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
    <PageScaffold
      title="Monthly Ukrainian UAVs Downed - RU MoD"
      description="Monthly sums of Russian MoD air-defense intercept claims (MSK drone-days). Current month shows an end-of-month projection. A dashed outline marks months containing a report whose window may overlap a neighbor (possible double-count) — see tooltip."
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-mod" />}
      controls={<>
        {!yr.hidden && (
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
        )}
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading RU air-defense database…"
      gridChildren={<>
        <MonthlyBarChart title="UAVs Downed — Monthly Total" data={makeDataset("total")} wfull
          globalMax={allStats.total?.max ?? 0} globalMedian={allStats.total?.median ?? 0} globalTotal={allStats.total?.total ?? 0} />
        <MonthlyBarChart title="Overnight Reports" data={makeDataset("night")} wfull={false}
          globalMax={allStats.night?.max ?? 0} globalMedian={allStats.night?.median ?? 0} globalTotal={allStats.night?.total ?? 0} />
        <MonthlyBarChart title="Daytime Reports" data={makeDataset("day")} wfull={false}
          globalMax={allStats.day?.max ?? 0} globalMedian={allStats.day?.median ?? 0} globalTotal={allStats.day?.total ?? 0} />
      </>}
    />
  );
}
