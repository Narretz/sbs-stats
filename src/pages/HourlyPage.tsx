import { useState, useMemo, useEffect } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { HourlyLineChart, type TooltipSortMode } from "@/components/HourlyLineChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
import type { DailyRow, DailyDaySeries, GlobalStats, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";

const DAY_OPTIONS = [7, 14, 30, 60] as const;
type DayOption = (typeof DAY_OPTIONS)[number];
const SORT_OPTIONS: TooltipSortMode[] = ["value", "date"];

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const d = Number(p.get("days"));
  const s = p.get("sort");
  return {
    days: (DAY_OPTIONS as readonly number[]).includes(d) ? (d as DayOption) : 30,
    sort: (SORT_OPTIONS.includes(s as TooltipSortMode) ? s : "value") as TooltipSortMode,
  };
}

function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) p.set(k, v);
  const url = `${window.location.pathname}?${p.toString()}`;
  window.history.replaceState(null, "", url);
}

interface HourlyPageProps {
  refreshKey?: number;
}

export function HourlyPage({ refreshKey }: HourlyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryHourly, queryGlobalStats } = useDatabaseContext();
  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({} as GlobalStats);
  const [hasData, setHasData] = useState(false);
  const [tooltipSort, setTooltipSort] = useState<TooltipSortMode>(initial.sort);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateSort = (s: TooltipSortMode) => { setTooltipSort(s); setUrlParams({ sort: s }); };

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") { setRows(queryHourly(days)); setHasData(true); }
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
                        <br/>
            <span style={{ color: t.textImportant, background: t.bgImportant, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4}}>The hourly values are recorded exactly as they were at the time of collection, and may be inaccurate because of delayed scheduling. They are also not updated after the current day is over (especially the daily totals are often updated late in the day, or in the next day)</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {(["value", "date"] as const).map((mode) => (
              <button key={mode} onClick={() => updateSort(mode)} style={{
                background: tooltipSort === mode ? t.accent : t.bgAlt,
                color: tooltipSort === mode ? "#fff" : t.textMuted,
                border: `1px solid ${tooltipSort === mode ? t.accent : t.border}`,
                borderRadius: 4, padding: "5px 12px",
                fontFamily: FONTS.mono, fontSize: 11,
                fontWeight: tooltipSort === mode ? 700 : 400,
                cursor: "pointer", transition: "all 0.15s",
              }}>{mode === "value" ? "Sort: Value" : "Sort: Date"}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {DAY_OPTIONS.map((d) => (
              <button key={d} onClick={() => updateDays(d)} style={{
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
      </div>
      {loadState === "loading" && !hasData && <LoadingScreen />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {metrics.map((m: Metric) => (
            <HourlyLineChart
              key={m.key}
              title={m.label}
              data={makeDataset(m.key)}
              globalMax={globalStats[m.key]?.max ?? 0}
              globalMedian={globalStats[m.key]?.median ?? 0}
              wfull={m.wfull ?? false}
              tooltipSort={tooltipSort}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
