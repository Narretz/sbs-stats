import { useMemo } from "react";
import { useRuModDatabaseContext } from "@/context/databases";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import type { MonthlyDataPoint } from "@/types";

interface Props {
  refreshKey?: number;
}

const RU_MOD_KEYS = ["total", "night", "day"] as const;
type MetricKey = (typeof RU_MOD_KEYS)[number];

export function RuModMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryMonthly, queryDataWindow } = useRuModDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const { rows, hasData, yr, allStats } = useMonthlyMetricGrid({
    loadState, queryMonthly, refreshKey, keys: RU_MOD_KEYS,
  });

  const endMonth = resolvedEndMonth("Europe/Moscow");
  const makeDataset = (key: MetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
      rows.map((d) => {
        const value = d[key];
        const projected = d[`${key}_projected`];
        // Only the overall-total chart carries these caveats (both are about a
        // report's whole window, not its night/day split).
        const notes: string[] = [];
        if (key === "total" && d.overlap_reports > 0)
          notes.push(`includes ${d.overlap_reports} report${d.overlap_reports > 1 ? "s" : ""} whose window may overlap a neighbor — possible double-count`);
        if (key === "total" && d.air_target_reports > 0)
          notes.push(`includes ${d.air_target_drones} from ${d.air_target_reports} report${d.air_target_reports > 1 ? "s" : ""} the MoD counted as «воздушных целей» (air targets) — may include non-UAV kills`);
        const note = notes.length ? notes.join("\n") : undefined;
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
      description="Monthly sums of Russian MoD air-defense intercept claims (MSK drone-days). Current month shows an end-of-month projection. A dashed outline marks months containing a caveated report — a window that may overlap a neighbor (possible double-count), or one the MoD counted as air targets rather than UAVs — see tooltip."
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
