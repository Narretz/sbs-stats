import { useEffect, useState } from "react";
import { useRuLossesDatabaseContext } from "@/context/useRuLossesDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
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
  const { loadState, error, queryMonthly } = useRuLossesDatabaseContext();
  const [rows, setRows] = useState<RuLossesMonthlyRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryMonthly());
      setHasData(true);
    }
  }, [loadState, queryMonthly, refreshKey]);

  const makeDataset = (key: RuLossesMetricKey): MonthlyDataPoint[] =>
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
    });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Monthly Russian Losses
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Monthly sums of daily losses claimed by the Ukrainian General Staff. Current month shows end-of-month projection.
          </p>
        </div>
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
