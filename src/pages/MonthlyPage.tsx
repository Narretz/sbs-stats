import { useMemo, useEffect, useState } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
import type { MonthlyDataPoint, MonthlyRow, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";

interface MonthlyPageProps {
  refreshKey?: number;
}

export function MonthlyPage({ refreshKey }: MonthlyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly } = useDatabaseContext();
  const [rows, setRows] = useState<MonthlyRow[]>([]);

  useEffect(() => {
    if (loadState === "ready") setRows(queryMonthly());
  }, [loadState, queryMonthly, refreshKey]);

  const metrics = useMemo<Metric[]>(() => buildMetrics(), []);

  const makeDataset = (key: StatKey): MonthlyDataPoint[] =>
    rows.map((d: MonthlyRow) => {
      const value = (d[key] as number) ?? 0;
      const projected = d[`${key}_projected`] as number | undefined;
      return {
        date: d.date, value,
        gap: projected != null ? projected - value : undefined,
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
            Monthly Statistics
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Monthly aggregates · current month shows end-of-month projection
          </p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 20, marginBottom: 20, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: t.primary }}>■ Past months</span>
        <span style={{ color: t.accent }}>■ Current (actual)</span>
        <span style={{ color: t.accent + "88" }}>■ Projected</span>
      </div>

      {loadState === "loading" && <LoadingScreen />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {loadState === "ready" && (
        <ChartGrid>
          {metrics.map((m: Metric) => (
            <MonthlyBarChart
              key={m.key}
              title={m.label}
              data={makeDataset(m.key)}
              wfull={m.wfull ?? false}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
