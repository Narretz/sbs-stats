import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { HourlyLineChart, type TooltipSortMode } from "@/components/HourlyLineChart";
import { DataWindow } from "@/components/DataWindow";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { TooltipSortSelect } from "@/components/TooltipSortSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam } from "@/utils/dayRange";
import { buildMetrics } from "@/utils/metrics";
import type { DailyRow, DailyDaySeries, GlobalStats, StatKey, Metric, EodEstimate } from "@/types";

// A destroyed chart borrows its hit counterpart's scale so the two are
// visually comparable (destroyed is always a subset of hit).
function scaleSourceKey(key: StatKey): StatKey | null {
  if (key === "total_targets_destroyed") return "total_targets_hit";
  if (key.startsWith("destroyed_")) return ("hit_" + key.slice("destroyed_".length)) as StatKey;
  return null;
}
import { FONTS } from "@/theme";

const SORT_OPTIONS: TooltipSortMode[] = ["value", "date"];
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
  const s = p.get("sort");
  return {
    days: parseDaysParam(p.get("days")),
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

export function SbsHourlyPage({ refreshKey }: HourlyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryHourly, queryGlobalStats, queryEodProjection, queryDataWindow } = useDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({} as GlobalStats);
  const [eod, setEod] = useState<Partial<Record<StatKey, EodEstimate>>>({});
  const [hasData, setHasData] = useState(false);
  const [tooltipSort, setTooltipSort] = useState<TooltipSortMode>(initial.sort);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateSort = (s: TooltipSortMode) => { setTooltipSort(s); setUrlParams({ sort: s }); };
  const updateWeekdays = (next: number[]) => {
    setSelectedWeekdays(next);
    setUrlParams({ weekdays: next.join(",") });
  };

  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Kyiv").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;

  useEffect(() => {
    if (loadState === "ready") {
      setGlobalStats(queryGlobalStats());
      setEod(queryEodProjection());
    }
  }, [loadState, queryGlobalStats, queryEodProjection, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryHourly(days, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryHourly, refreshKey]);

  const todayDow = new Date(
    new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00"
  ).getDay();

  const metrics = useMemo<Metric[]>(() => buildMetrics(), []);

  const filteredRows = useMemo(() => {
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      return rows.filter(row => row.date >= startDate && row.date <= selectedDate);
    }
    if (selectedWeekdays.length === 0) return rows;
    return rows.filter(row => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
  }, [rows, selectedWeekdays, selectedDate, days]);

  const makeDataset = (key: StatKey): DailyDaySeries[] => {
    const map = new Map<string, DailyDaySeries>();
    for (const row of filteredRows) {
      if (!map.has(row.date)) map.set(row.date, { date: row.date, is_today: row.is_today, points: [] });
      map.get(row.date)!.points.push({
        hour: row.hour,
        value: typeof row[key] === "number" ? (row[key] as number) : null,
      });
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
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          UA SBS Hourly Statistics
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Syly bezpilotnykh system / Unmannend System Force (SBS/USF) · Each line = one day · X-axis = hour · From <a href="noreferer nofollow">https://sbs-group.army/</a>
                      <br/>
          <span style={{ color: t.textImportant, border: `2px solid ${t.borderImportant}`, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4}}>The hourly values are recorded exactly as they were at the time of collection, and may be inaccurate because of delayed scheduling. They are also not updated after the current day is over (especially the daily totals are often updated late in the day, or in the next day)</span>
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="sbs" />
      </div>
      <div className="page-controls-sticky" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
        <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
        <WeekdayMultiSelect
          selected={selectedWeekdays}
          onChange={updateWeekdays}
          todayDow={todayDow}
        />
        <StatScopeToggle />
        <TooltipSortSelect value={tooltipSort} onChange={updateSort} />
      </div>
      {loadState === "loading" && !hasData && <LoadingScreen />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {metrics.map((m: Metric) => {
            const srcKey = scaleSourceKey(m.key);
            return (
              <HourlyLineChart
                key={m.key}
                title={m.label}
                data={makeDataset(m.key)}
                globalMax={globalStats[m.key]?.max ?? 0}
                globalMedian={globalStats[m.key]?.median ?? 0}
                globalTotal={globalStats[m.key]?.total ?? 0}
                wfull={m.wfull ?? false}
                tooltipSort={tooltipSort}
                highlight={!!selectedDate}
                selectedDate={selectedDate}
                eod={eod[m.key] ?? null}
                pairedData={srcKey ? makeDataset(srcKey) : undefined}
                pairedGlobalMax={srcKey ? globalStats[srcKey]?.max ?? 0 : undefined}
              />
            );
          })}
        </ChartGrid>
      )}
    </div>
  );
}
