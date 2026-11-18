import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRuModDatabaseContext } from "@/context/databases";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { MoreControls } from "@/components/MoreControls";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { PageScaffold } from "@/components/PageScaffold";
import { noDaysMonth, padTrailingMonthly } from "@/utils/padTrailing";
import type { MonthlyDataPoint } from "@/types";
import { chartAnchor } from "@/utils/chartAnchor";
import { RU_MOD_DAILY_TOTAL_TITLE, RU_MOD_DAILY_WINDOWS_TITLE, siteTitle } from "@/types";
import { monthRegionList, type RegionMonth } from "@/utils/ruModRegions";
import { RuModRegionList } from "@/components/RuModRegionList";
import { BarOrderSelect } from "@/components/BarOrderSelect";
import { useBarOrder } from "@/hooks/useBarOrder";

interface Props {
  refreshKey?: number;
}

const RU_MOD_KEYS = ["total", "night", "day"] as const;
type MetricKey = (typeof RU_MOD_KEYS)[number];

export function RuModMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryMonthly, queryMonthlyRegions, queryDataWindow } = useRuModDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [order, setOrder] = useBarOrder();
  const { allRows, rows, hasData, yr, allStats, ranking } = useMonthlyMetricGrid({
    loadState, queryMonthly, refreshKey, keys: RU_MOD_KEYS, tz: "Europe/Moscow", order,
  });

  const [regions, setRegions] = useState<Map<string, Record<MetricKey, RegionMonth[]>>>(new Map());
  useEffect(() => {
    if (loadState === "ready") setRegions(queryMonthlyRegions());
  }, [loadState, queryMonthlyRegions, refreshKey]);
  // Each chart's tooltip lists the regions its series' reports named that month.
  const regionLists = useMemo(() => {
    const out = { total: new Map<string, ReactNode>(), night: new Map<string, ReactNode>(), day: new Map<string, ReactNode>() };
    for (const [month, series] of regions) {
      for (const key of RU_MOD_KEYS) {
        const list = monthRegionList(series[key]);
        if (list) out[key].set(month, <RuModRegionList list={list} tall />);
      }
    }
    return out;
  }, [regions]);

  const endMonth = yr.endMonth;
  const makeDataset = (key: MetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly<MonthlyDataPoint>(
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
          projection_partial_day: d.projection_partial_day,
          daily_median: d[`${key}_daily_median`],
          days_available: d[`${key}_days`],
          note,
        };
      }),
      endMonth,
      noDaysMonth,
    );

  return (
    <PageScaffold
      title={siteTitle("ru-airdef-mod", "Monthly")}
      description="Monthly sums of Russian MoD air-defense intercept claims (MSK drone-days). Current month shows an end-of-month projection. A dashed outline marks months containing a caveated report — a window that may overlap a neighbor (possible double-count), or one the MoD counted as air targets rather than UAVs — see tooltip. The tooltip lists the regions the month's reports named: the UAVs the MoD counted over each, where it gave per-region counts (it stopped in spring 2026), and the days it was named on."
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-mod" />}
      // No window picker → no scope toggle either; see StatScopeToggle.
      controls={yr.hidden ? undefined : (
        <>
          <MonthWindowControls yr={yr} min={allRows[0]?.date ?? ""} />
          <BarOrderSelect value={order} onChange={setOrder} />
          <MoreControls>
            <StatScopeToggle />
          </MoreControls>
        </>
      )}
      ranking={ranking}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading RU air-defense database…"
      gridChildren={<>
        <MonthlyBarChart title="UAVs Downed — Monthly Total" drillAnchor={chartAnchor(RU_MOD_DAILY_TOTAL_TITLE)} data={makeDataset("total")} wfull detailByDate={regionLists.total}
          globalMax={allStats.total?.max ?? 0} globalMedian={allStats.total?.median ?? 0} globalTotal={allStats.total?.total ?? 0} />
        <MonthlyBarChart title="Overnight Reports" drillAnchor={chartAnchor(RU_MOD_DAILY_WINDOWS_TITLE)} data={makeDataset("night")} wfull={false} detailByDate={regionLists.night}
          globalMax={allStats.night?.max ?? 0} globalMedian={allStats.night?.median ?? 0} globalTotal={allStats.night?.total ?? 0} />
        <MonthlyBarChart title="Daytime Reports" drillAnchor={chartAnchor(RU_MOD_DAILY_WINDOWS_TITLE)} data={makeDataset("day")} wfull={false} detailByDate={regionLists.day}
          globalMax={allStats.day?.max ?? 0} globalMedian={allStats.day?.median ?? 0} globalTotal={allStats.day?.total ?? 0} />
      </>}
    />
  );
}
