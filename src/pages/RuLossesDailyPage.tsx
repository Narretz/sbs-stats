import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useRuLossesDatabaseContext } from "@/context/useRuLossesDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DataWindow } from "@/components/DataWindow";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam } from "@/utils/dayRange";
import {
  RU_LOSSES_METRIC_KEYS,
  RU_LOSSES_METRIC_LABELS,
  type RuLossesDailyRow,
  type RuLossesGlobalStats,
  type RuLossesMetricKey,
} from "@/types";
import { FONTS } from "@/theme";


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

export function RuLossesDailyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryDaily, queryGlobalStats, queryDataWindow } = useRuLossesDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<RuLossesDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<RuLossesGlobalStats>({} as RuLossesGlobalStats);
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

  const todayDow = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00").getDay();
  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Kyiv").toString();
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

  const makeDataset = (key: RuLossesMetricKey) =>
    filteredRows.map((d) => ({
      date: d.date,
      value: typeof d[key] === "number" ? (d[key] as number) : null,
      is_today: d.is_today,
    }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Daily Russian Losses - GSUA reports
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Daily Russian losses reported by the Ukrainian General Staff · source: <a href="https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset" rel="nofollow external" target="_blank">PetroIvaniuk dataset</a>
          </p>
          <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-losses" />
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
          <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
          <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
          <StatScopeToggle />
        </div>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU losses database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {RU_LOSSES_METRIC_KEYS.map((k) => (
            <DailyLineChart
              key={k}
              title={RU_LOSSES_METRIC_LABELS[k]}
              data={makeDataset(k)}
              globalMax={globalStats[k]?.max ?? 0}
              globalMedian={globalStats[k]?.median ?? 0}
              globalTotal={globalStats[k]?.total ?? 0}
              wfull={k === "personnel"}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
