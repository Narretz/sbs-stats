import { useEffect, useMemo, useState } from "react";
import { useRuLossesDatabaseContext } from "@/context/useRuLossesDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyYearRange } from "@/hooks/useMonthlyYearRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { YearRangeSelect } from "@/components/YearRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import {
  RU_LOSSES_METRIC_KEYS,
  RU_LOSSES_METRIC_LABELS,
  type RuLossesMetricKey,
  type RuLossesMonthlyRow,
  type MonthlyDataPoint,
} from "@/types";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

export function RuLossesMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryDataWindow } = useRuLossesDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [allRows, setAllRows] = useState<RuLossesMonthlyRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const yr = useMonthlyYearRange(allRows.length);
  const rows = useMemo(() => yr.slice(allRows), [allRows, yr]);

  useEffect(() => {
    if (loadState === "ready") {
      setAllRows(queryMonthly());
      setHasData(true);
    }
  }, [loadState, queryMonthly, refreshKey]);

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
    <div>
      <div style={{ display: "flex", gap: 8, flexDirection: 'column', marginBottom: 28 }}>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Monthly Russian Losses - GSUA reports
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Monthly sums of daily Russian losses reported by the Ukrainian General Staff · source: <a href="https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset" rel="nofollow external" target="_blank">PetroIvaniuk dataset</a>
          </p>
          <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-losses" />
        {!yr.hidden && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <YearRangeSelect options={yr.yearOptions} value={yr.years} onChange={yr.setYears} />
          </div>
        )}
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU losses database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {RU_LOSSES_METRIC_KEYS.map((k) => (
            <MonthlyBarChart
              key={k}
              title={RU_LOSSES_METRIC_LABELS[k]}
              data={makeDataset(k)}
              wfull={k === "personnel"}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
