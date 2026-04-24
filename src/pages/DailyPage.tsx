import { useState, useMemo, useEffect } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
import type { DailyRow, DailyDataPoint, GlobalStats, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";

const DAY_OPTIONS = [7, 14, 30, 60, 90, 120, 150, 180] as const;
type DayOption = (typeof DAY_OPTIONS)[number];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseWeekdays(raw: string | null): number[] {
  if (!raw) return [];
  const parsed = raw.split(",").map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const d = Number(p.get("days"));
  return {
    days: (DAY_OPTIONS as readonly number[]).includes(d) ? (d as DayOption) : 30,
    weekdays: parseWeekdays(p.get("weekdays")),
    date: parseDate(p.get("date")),
  };
}

function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) p.set(k, v);
  const url = `${window.location.pathname}?${p.toString()}`;
  window.history.replaceState(null, "", url);
}

interface DailyPageProps {
  refreshKey?: number;
}

export function DailyPage({ refreshKey }: DailyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryDaily, queryGlobalStats } = useDatabaseContext();
  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({} as GlobalStats);
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const toggleWeekday = (dow: number) => {
    setSelectedWeekdays(prev => {
      const next = prev.includes(dow)
        ? prev.filter(d => d !== dow)
        : [...prev, dow].sort((a, b) => a - b);
      setUrlParams({ weekdays: next.join(",") });
      return next;
    });
  };

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(days, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryDaily, refreshKey]);

  const metrics = useMemo<Metric[]>(() => buildMetrics(), []);

  const todayDow = new Date(
    new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00"
  ).getDay();

  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

  const filteredRows = useMemo(() => {
    if (selectedDate) {
      const startDate = shiftDate(selectedDate, -days);
      return rows.filter(row => row.date >= startDate && row.date <= selectedDate);
    }
    if (selectedWeekdays.length === 0) return rows;
    return rows.filter(row => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
  }, [rows, selectedWeekdays, selectedDate, days]);

  const chartStats = useMemo<GlobalStats>(() => {
    if (filteredRows.length === 0) return globalStats;
    const result = {} as GlobalStats;
    for (const m of metrics) {
      const vals = filteredRows.map(r => (r[m.key] as number) ?? 0).sort((a, b) => a - b);
      result[m.key] = { max: Math.max(...vals), median: vals[Math.floor(vals.length / 2)] };
    }
    return result;
  }, [filteredRows, globalStats, metrics]);

  const makeDataset = (key: StatKey): DailyDataPoint[] =>
    filteredRows.map((d) => ({ date: d.date, value: (d[key] as number) ?? 0, is_today: d.is_today }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Daily Statistics
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Latest reported value per day · MAX/MED based on all data · {new Date().toDateString()}
            <br/>
            <span style={{ color: t.textImportant, background: t.bgImportant, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4}}>Since 2026-03-19, the daily values are the results of the "Previous day" endpoint if the current day has passed. Older daily values reflect the results of the latest request to the "Current day" endpoint. Results often adjusted hours or even a day later.</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {DOW_LABELS.map((label, dow) => (
              <button key={dow} onClick={() => toggleWeekday(dow)} style={{
                background: selectedWeekdays.includes(dow) ? t.accent : t.bgAlt,
                color: selectedWeekdays.includes(dow) ? "#fff" : t.textMuted,
                border: `1px solid ${selectedWeekdays.includes(dow) ? t.accent : t.border}`,
                borderRadius: 4, padding: "5px 12px",
                fontFamily: FONTS.mono, fontSize: 11,
                fontWeight: selectedWeekdays.includes(dow) ? 700 : 400,
                cursor: "pointer", transition: "all 0.15s",
                boxShadow: dow === todayDow ? `0 2px 0 0 ${t.text}` : undefined,
              }}>{label}</button>
            ))}
          </div>
          <input
            type="date"
            value={selectedDate}
            max={maxSelectableDate}
            onChange={e => updateDate(e.target.value)}
            style={{
              background: selectedDate ? t.accent : t.bgAlt,
              color: selectedDate ? "#fff" : t.textMuted,
              border: `1px solid ${selectedDate ? t.accent : t.border}`,
              borderRadius: 4, padding: "5px 8px",
              fontFamily: FONTS.mono, fontSize: 11,
              cursor: "pointer", transition: "all 0.15s",
              colorScheme: "dark",
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            {DAY_OPTIONS.map((d) => (
              <button key={d} onClick={() => updateDays(d)} style={{
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
      </div>
      {loadState === "loading" && !hasData && <LoadingScreen />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {metrics.map((m: Metric) => (
            <DailyLineChart
              key={m.key}
              title={m.label}
              data={makeDataset(m.key)}
              globalMax={chartStats[m.key]?.max ?? 0}
              globalMedian={chartStats[m.key]?.median ?? 0}
              wfull={m.wfull ?? false}
              highlight={!!selectedDate}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
