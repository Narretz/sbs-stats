import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useRuModDatabaseContext } from "@/context/useRuModDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DailyMultiLineChart } from "@/components/DailyMultiLineChart";
import { DataWindow } from "@/components/DataWindow";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam } from "@/utils/dayRange";
import { fillDailyRange, resolvedEndDate } from "@/utils/padTrailing";
import type { RuAdDailyRow, RuAdGlobalStats } from "@/types";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";


function parseWeekdays(raw: string | null): number[] {
  if (!raw) return [];
  const parsed = raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(parsed)].sort((a, b) => a - b);
}
function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}
function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    days: parseDaysParam(p.get("days")),
    weekdays: parseWeekdays(p.get("weekdays")),
    date: parseDate(p.get("date")),
  };
}
function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === "") p.delete(k);
    else p.set(k, v);
  }
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

interface Props {
  refreshKey?: number;
}

export function RuModDailyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryDaily, queryGlobalStats, queryDataWindow } = useRuModDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<RuAdDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<RuAdGlobalStats>(() => {
    const zero = { max: 0, median: 0, total: 0 };
    return { total: zero, night: zero, day: zero };
  });
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateWeekdays = (next: number[]) => {
    setSelectedWeekdays(next);
    setUrlParams({ weekdays: next.join(",") });
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

  const todayDow = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" }) + "T12:00:00").getDay();
  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });

  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Moscow").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;

  const filteredRows = useMemo(() => {
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      return rows.filter((row) => row.date >= startDate && row.date <= selectedDate);
    }
    if (selectedWeekdays.length === 0) return rows;
    return rows.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
  }, [rows, selectedWeekdays, selectedDate, days]);

  const endDate = resolvedEndDate(selectedDate, "Europe/Moscow");
  const startDate = windowStartDate(endDate, days);
  // When a weekday filter is on, the chart deliberately drops other weekdays;
  // the fill must respect that so padding doesn't reintroduce them as gap rows.
  const keepDate = selectedWeekdays.length === 0
    ? undefined
    : (iso: string) => selectedWeekdays.includes(new Date(iso + "T12:00:00").getDay());
  // Compose the tooltip note from the per-report DB notes (already prefixed
  // with the report's HH:MM→HH:MM window in queryDaily) so the reader sees
  // exactly which window(s) overlap.
  const overlapForKey = (d: RuAdDailyRow, key: "total" | "night" | "day") => {
    const note = key === "total" ? d.overlap_note_total : key === "night" ? d.overlap_note_night : d.overlap_note_day;
    return note ?? undefined;
  };
  const makeDataset = (key: "total" | "night" | "day") =>
    fillDailyRange(
      filteredRows.map((d) => ({
        date: d.date,
        value: d[key],
        is_today: d.is_today,
        note: overlapForKey(d, key),
      })),
      startDate,
      endDate,
      { keepDate },
    );

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Ukrainian UAVs Downed - RU MoD
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Russian MoD air-defense intercept claims · source: @mod_russia (Telegram) · per drone-day (MSK)
          <br />
          <span style={{ color: t.textImportant, border: `2px solid ${t.borderImportant}`, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4 }}>
            Russian MoD reports of UAVs intercepted/downed over Russia — a floor for the number launched, not a launch count. A day aggregates the overnight report (20:00 prev → 07:00) plus that day's daytime windows.
          </span>
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-mod" />
      </div>
      <div className="page-controls-sticky" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
        <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
        <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
        <StatScopeToggle />
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU air-defense database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          <DailyLineChart
            title="UAVs Downed — Daily Total"
            data={makeDataset("total")}
            globalMax={globalStats.total.max}
            globalMedian={globalStats.total.median}
            globalTotal={globalStats.total.total}
            wfull
          />
          <DailyMultiLineChart
            title="By Reporting Window — Overnight vs Daytime"
            series={[
              { key: "night", label: "Overnight", color: chartColors(t).overnight, data: makeDataset("night"),
                globalMax: globalStats.night.max, globalMedian: globalStats.night.median, globalTotal: globalStats.night.total },
              { key: "day", label: "Daytime", color: chartColors(t).daytime, data: makeDataset("day"),
                globalMax: globalStats.day.max, globalMedian: globalStats.day.median, globalTotal: globalStats.day.total },
            ]}
            wfull
          />
        </ChartGrid>
      )}
    </div>
  );
}
