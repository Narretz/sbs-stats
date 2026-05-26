import { useEffect, useState } from "react";
import { useGsuaDatabaseContext } from "@/context/useGsuaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import {
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  type GsuaMetricKey,
  type GsuaMonthlyRow,
  type MonthlyDataPoint,
} from "@/types";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

export function GsuaMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly } = useGsuaDatabaseContext();
  const [rows, setRows] = useState<GsuaMonthlyRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const monthly = await queryMonthly();
      if (cancelled) return;
      setRows(monthly);
      setHasData(true);
    })();
    return () => { cancelled = true; };
  }, [loadState, queryMonthly, refreshKey]);

  const makeDataset = (key: GsuaMetricKey): MonthlyDataPoint[] =>
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
            Monthly Combat Stats - GSUA
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Monthly sums of daily totals from Ukrainian General Staff reports. Current month shows end-of-month projection.  Via Telegram @GeneralStaffZSU.
          </p>
        </div>
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
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
