import { useState, useMemo, useEffect } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { HourlyLineChart, type TooltipSortMode } from "@/components/HourlyLineChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
import type { DailyRow, DailyDaySeries, GlobalStats, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";

const DAY_OPTIONS = [7, 14, 30, 60, 120] as const;
type DayOption = (typeof DAY_OPTIONS)[number];
const SORT_OPTIONS: TooltipSortMode[] = ["value", "date"];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseWeekdays(raw: string | null): number[] {
  if (!raw) return [];
  const parsed = raw.split(",").map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const d = Number(p.get("days"));
  const s = p.get("sort");
  return {
    days: (DAY_OPTIONS as readonly number[]).includes(d) ? (d as DayOption) : 30,
    sort: (SORT_OPTIONS.includes(s as TooltipSortMode) ? s : "value") as TooltipSortMode,
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
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateSort = (s: TooltipSortMode) => { setTooltipSort(s); setUrlParams({ sort: s }); };
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
    if (loadState === "ready") { setRows(queryHourly(days)); setHasData(true); }
  }, [loadState, days, queryHourly, refreshKey]);

  const todayDow = new Date(
    new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00"
  ).getDay();

  const metrics = useMemo<Metric[]>(() => buildMetrics(), []);

  const minDate = rows[0]?.date ?? "";
  const maxDate = rows[rows.length - 1]?.date ?? "";

  const filteredRows = useMemo(() => {
    if (selectedDate) return rows.filter(row => row.date === selectedDate);
    if (selectedWeekdays.length === 0) return rows;
    return rows.filter(row => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
  }, [rows, selectedWeekdays, selectedDate]);

  const chartStats = useMemo<GlobalStats>(() => {
    if (filteredRows.length === 0) return globalStats;
    // Deduplicate to latest hour per date (mirrors queryGlobalStats logic)
    const latest = new Map<string, DailyRow>();
    for (const row of filteredRows) {
      const existing = latest.get(row.date);
      if (!existing || row.hour > existing.hour) latest.set(row.date, row);
    }
    const deduped = Array.from(latest.values());
    const result = {} as GlobalStats;
    for (const m of metrics) {
      const vals = deduped.map(r => (r[m.key] as number) ?? 0).sort((a, b) => a - b);
      result[m.key] = { max: Math.max(...vals), median: vals[Math.floor(vals.length / 2)] };
    }
    return result;
  }, [filteredRows, globalStats, metrics]);

  const makeDataset = (key: StatKey): DailyDaySeries[] => {
    const map = new Map<string, DailyDaySeries>();
    for (const row of filteredRows) {
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
          <input
            type="date"
            value={selectedDate}
            min={minDate}
            max={maxDate}
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
            <HourlyLineChart
              key={m.key}
              title={m.label}
              data={makeDataset(m.key)}
              globalMax={chartStats[m.key]?.max ?? 0}
              globalMedian={chartStats[m.key]?.median ?? 0}
              wfull={m.wfull ?? false}
              tooltipSort={tooltipSort}
              highlight={!!selectedDate}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
