import { useEffect, useMemo, useState } from "react";
import { useUaLossesDatabaseContext } from "@/context/databases";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import {
  UA_LOSSES_METRIC_KEYS,
  UA_LOSSES_METRIC_LABELS,
  type UaLossesMetricKey,
  type UaLossesMonthlyRow,
  type MonthlyDataPoint,
} from "@/types";

interface Props {
  refreshKey?: number;
}

export function UaLossesMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryMonthly, queryDataWindow } = useUaLossesDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [allRows, setAllRows] = useState<UaLossesMonthlyRow[]>([]);
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
    const out: Record<string, { max: number; median: number; total: number }> = {};
    for (const k of UA_LOSSES_METRIC_KEYS) {
      out[k] = maxMedian(allRows.map((r) => (typeof r[k] === "number" ? r[k] : null)));
    }
    return out;
  }, [allRows]);

  const endMonth = resolvedEndMonth();
  const makeDataset = (key: UaLossesMetricKey): MonthlyDataPoint[] =>
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
      title="Monthly Ukrainian Losses - ualosses.org"
      description={<>Monthly sums of confirmed Ukrainian military personnel losses, by status · source: <a href="https://ualosses.org" rel="nofollow external" target="_blank">ualosses.org</a> (via <a href="https://www.kaggle.com/datasets/ol4ubert/confirmed-ukrainian-military-personnel-losses" rel="nofollow external" target="_blank">Kaggle</a>). Days are keyed by the reported loss date; past days are revised as records are added or reclassified.</>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ua-losses" />}
      controls={<>
        {!yr.hidden && (
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
        )}
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading UA losses database…"
      gridChildren={UA_LOSSES_METRIC_KEYS.map((k) => (
        <MonthlyBarChart
          key={k}
          title={UA_LOSSES_METRIC_LABELS[k]}
          data={makeDataset(k)}
          wfull={false}
          globalMax={allStats[k]?.max ?? 0}
          globalMedian={allStats[k]?.median ?? 0}
          globalTotal={allStats[k]?.total ?? 0}
        />
      ))}
    />
  );
}
