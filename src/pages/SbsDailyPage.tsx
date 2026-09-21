import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useSbsDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DataWindow } from "@/components/DataWindow";
import { PageScaffold } from "@/components/PageScaffold";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam, clampDays, WINDOW_FLOOR } from "@/utils/dayRange";
import { fillDailyRange, resolvedEndDate } from "@/utils/padTrailing";
import { buildMetrics } from "@/utils/metrics";
import type { DailyRow, DailyDataPoint, GlobalStats, StatKey, Metric, EodEstimate } from "@/types";


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
  return {
    // Clamped on the way in rather than after mount: a `days` straight from
    // the URL gets one query and one chart padded to it before anything
    // downstream could correct it.
    days: parseDaysParam(p.get("days"), resolvedEndDate(parseDate(p.get("date")))),
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

export function SbsDailyPage({ refreshKey }: DailyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryDaily, queryGlobalStats, queryEodProjection, queryDataWindow } = useSbsDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({} as GlobalStats);
  const [eod, setEod] = useState<Partial<Record<StatKey, EodEstimate>>>({});
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => {
    const capped = clampDays(d, endDate);
    setDays(capped);
    setUrlParams({ days: String(capped) });
  };
  const updateDate = (d: string) => {
    setSelectedDate(d);
    // A window is measured back from its end, so moving the end earlier
    // pushes the start earlier by the same amount. Shorten it instead of
    // letting it cross the floor.
    const capped = clampDays(days, resolvedEndDate(d));
    setDays(capped);
    setUrlParams({ date: d, days: String(capped) });
  };
  const updateWeekdays = (next: number[]) => {
    setSelectedWeekdays(next);
    setUrlParams({ weekdays: next.join(",") });
  };

  useEffect(() => {
    if (loadState === "ready") {
      setGlobalStats(queryGlobalStats());
      setEod(queryEodProjection());
    }
  }, [loadState, queryGlobalStats, queryEodProjection, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(days, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryDaily, refreshKey]);

  const metrics = useMemo<Metric[]>(() => buildMetrics({ paired: true }), []);

  const todayDow = new Date(
    new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00"
  ).getDay();

  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Kyiv").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate || next < WINDOW_FLOOR) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;
  // "live" sits at today, so there is always a day behind it.
  const canGoPrev = selectedDate === "" || selectedDate > WINDOW_FLOOR;

  const filteredRows = useMemo(() => {
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      return rows.filter(row => row.date >= startDate && row.date <= selectedDate);
    }
    if (selectedWeekdays.length === 0) return rows;
    return rows.filter(row => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
  }, [rows, selectedWeekdays, selectedDate, days]);

  const endDate = resolvedEndDate(selectedDate);
  const startDate = windowStartDate(endDate, days);
  // Weekday filter is intentional — don't pad dates that the user filtered out.
  const keepDate = selectedWeekdays.length === 0
    ? undefined
    : (iso: string) => selectedWeekdays.includes(new Date(iso + "T12:00:00").getDay());
  const makeDataset = (key: StatKey): DailyDataPoint[] =>
    fillDailyRange(
      filteredRows.map((d) => ({
        date: d.date,
        value: typeof d[key] === "number" ? (d[key] as number) : null,
        is_today: d.is_today,
      })),
      startDate,
      endDate,
      { keepDate },
    );

  return (
    <PageScaffold
      headerVariant="block"
      title="UA SBS Daily Statistics"
      description={<>
        Syly bezpilotnykh system / Unmannend System Force (SBS/USF) · Latest reported value per day · From <a href="noreferer nofollow">https://sbs-group.army/</a>
        <br/>
        <span style={{ color: t.textImportant, border: `2px solid ${t.borderImportant}`, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4}}>Since 2026-03-19, the daily values are the results of the "Previous day" endpoint if the current day has passed. Older daily values reflect the results of the latest request to the "Current day" endpoint. Results often adjusted hours or even a day later.</span>
      </>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="sbs" />}
      controls={<>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} endDate={endDate} minDate={dataWindow.minDate ?? undefined} />
        <DateNav label="End" value={selectedDate} min={WINDOW_FLOOR} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} canGoPrev={canGoPrev} />
        <WeekdayMultiSelect
          selected={selectedWeekdays}
          onChange={updateWeekdays}
          todayDow={todayDow}
        />
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      gridChildren={metrics.map((m: Metric) => (
        <DailyLineChart
          key={m.id}
          title={m.label}
          data={makeDataset(m.key)}
          globalMax={globalStats[m.key]?.max ?? 0}
          globalMedian={globalStats[m.key]?.median ?? 0}
          globalTotal={globalStats[m.key]?.total ?? 0}
          wfull={m.wfull ?? false}
          data2={m.pairedKey ? makeDataset(m.pairedKey) : undefined}
          primaryLabel={m.primaryLabel}
          label2={m.pairedLabel}
          subsetLabel={m.subsetLabel}
          globalMax2={m.pairedKey ? globalStats[m.pairedKey]?.max ?? 0 : undefined}
          globalMedian2={m.pairedKey ? globalStats[m.pairedKey]?.median ?? 0 : undefined}
          globalTotal2={m.pairedKey ? globalStats[m.pairedKey]?.total ?? 0 : undefined}
          pairMode={m.pairMode}
          eod={eod[m.key] ?? null}
          eod2={m.pairedKey ? (eod[m.pairedKey] ?? null) : undefined}
        />
      ))}
    />
  );
}
