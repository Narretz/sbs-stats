import { useMemo } from "react";
import { useRuLossesDatabaseContext } from "@/context/databases";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import {
  RU_LOSSES_METRIC_KEYS,
  RU_LOSSES_METRIC_LABELS,
  type RuLossesMetricKey,
  type MonthlyDataPoint,
} from "@/types";

interface Props {
  refreshKey?: number;
}

export function RuLossesMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryMonthly, queryDataWindow } = useRuLossesDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const { rows, hasData, yr, allStats } = useMonthlyMetricGrid({
    loadState, queryMonthly, refreshKey, keys: RU_LOSSES_METRIC_KEYS,
  });

  const endMonth = resolvedEndMonth();
  const makeDataset = (key: RuLossesMetricKey): MonthlyDataPoint[] =>
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
      title="Monthly Russian Losses - GSUA reports"
      description={<>Monthly sums of daily Russian losses reported by the Ukrainian General Staff · source: <a href="https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset" rel="nofollow external" target="_blank">PetroIvaniuk dataset</a></>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-losses" />}
      controls={<>
        {!yr.hidden && (
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
        )}
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading RU losses database…"
      gridChildren={RU_LOSSES_METRIC_KEYS.map((k) => (
        <MonthlyBarChart
          key={k}
          title={RU_LOSSES_METRIC_LABELS[k]}
          data={makeDataset(k)}
          wfull={k === "personnel"}
          globalMax={allStats[k]?.max ?? 0}
          globalMedian={allStats[k]?.median ?? 0}
          globalTotal={allStats[k]?.total ?? 0}
        />
      ))}
    />
  );
}
