import { useState, useMemo, useEffect } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
import type { DailyRow, DailyDataPoint, GlobalStats, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";

const DAY_OPTIONS = [7, 14, 30, 60] as const;
type DayOption = (typeof DAY_OPTIONS)[number];

interface DailyPageProps {
  refreshKey?: number;
}

export function DailyPage({ refreshKey }: DailyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryDaily, queryGlobalStats } = useDatabaseContext();
  const [days, setDays] = useState<DayOption>(30);
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({} as GlobalStats);

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") setRows(queryDaily(days));
  }, [loadState, days, queryDaily, refreshKey]);

  const metrics = useMemo<Metric[]>(() => buildMetrics(), []);

  const makeDataset = (key: StatKey): DailyDataPoint[] =>
    rows.map((d) => ({ date: d.date, value: (d[key] as number) ?? 0, is_today: d.is_today }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Daily Statistics
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Latest reported value per day · MAX/MED based on all data · {new Date().toDateString()}
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {DAY_OPTIONS.map((d) => (
            <button key={d} onClick={() => setDays(d)} style={{
              background: days === d ? t.primary : t.bgAlt,
              color: days === d ? "#fff" : t.textMuted,
              border: `1px solid ${days === d ? t.primary : t.border}`,
              borderRadius: 4, padding: "5px 12px",
              fontFamily: FONTS.mono, fontSize: 11,
              fontWeight: days === d ? 700 : 400,
              cursor: "pointer", transition: "all 0.15s",
            }}>{d}d</button>
          ))}
        </div>
      </div>
      {loadState === "loading" && <LoadingScreen />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {loadState === "ready" && (
        <ChartGrid>
          {metrics.map((m: Metric) => (
            <DailyLineChart
              key={m.key}
              title={m.label}
              data={makeDataset(m.key)}
              globalMax={globalStats[m.key]?.max ?? 0}
              globalMedian={globalStats[m.key]?.median ?? 0}
              wfull={m.wfull ?? false}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
