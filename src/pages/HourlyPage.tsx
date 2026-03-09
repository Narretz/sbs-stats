import { useState, useMemo, useEffect } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { HourlyLineChart } from "@/components/HourlyLineChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
import type { DailyRow, DailyDaySeries, GlobalStats, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";

const DAY_OPTIONS = [7, 14, 30, 60] as const;
type DayOption = (typeof DAY_OPTIONS)[number];

interface HourlyPageProps {
  refreshKey?: number;
}

export function HourlyPage({ refreshKey }: HourlyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryHourly, queryGlobalStats } = useDatabaseContext();
  const [days, setDays] = useState<DayOption>(60);
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({} as GlobalStats);

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") setRows(queryHourly(days));
  }, [loadState, days, queryHourly, refreshKey]);

  const metrics = useMemo<Metric[]>(() => buildMetrics(), []);

  const makeDataset = (key: StatKey): DailyDaySeries[] => {
    const map = new Map<string, DailyDaySeries>();
    for (const row of rows) {
      if (!map.has(row.date)) map.set(row.date, { date: row.date, is_today: row.is_today, points: [] });
      map.get(row.date)!.points.push({ hour: row.hour, value: (row[key] as number) ?? 0 });
    }
    for (const s of map.values()) s.points.sort((a, b) => a.hour - b.hour);
    return Array.from(map.values()).sort((a, b) => {
      if (a.is_today) return 1;
      if (b.is_today) return -1;
      return a.date.localeCompare(b.date);
    });
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Hourly Statistics
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Each line = one day · X-axis = hour · MAX/MED based on all data · {new Date().toDateString()}
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {DAY_OPTIONS.map((d) => (
            <button key={d} onClick={() => setDays(d)} style={{
              background: days === d ? t.accent : t.bgAlt,
              color: days === d ? "#fff" : t.textMuted,
              border: `1px solid ${days === d ? t.accent : t.border}`,
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
            <HourlyLineChart
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
