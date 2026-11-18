import { useState, useMemo, useEffect, type ReactNode } from "react";
import { Temporal } from "temporal-polyfill";
import { useRuModDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DailyMultiLineChart } from "@/components/DailyMultiLineChart";
import type { SheetSource } from "@/components/TooltipTable";
import { DataWindow } from "@/components/DataWindow";
import { PageScaffold } from "@/components/PageScaffold";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { WindowStartNav } from "@/components/WindowStartNav";
import { MoreControls } from "@/components/MoreControls";
import { WeatherStripDaily } from "@/components/WeatherStripDaily";
import { WeatherToggle } from "@/components/WeatherToggle";
import { useWeatherStripPref } from "@/hooks/useWeatherStripPref";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam, clampDays, WINDOW_FLOOR, filterDailyRows, weekdayPredicate } from "@/utils/dayRange";
import { fillDailyRange, resolvedEndDate } from "@/utils/padTrailing";
import type { RuAdDailyRow, RuAdGlobalStats } from "@/types";
import { chartColors } from "@/chartColors";
import { regionList, type RegionMention } from "@/utils/ruModRegions";
import { RuModRegionList } from "@/components/RuModRegionList";
import { RU_MOD_DAILY_TOTAL_TITLE, RU_MOD_DAILY_WINDOWS_TITLE, siteTitle } from "@/types";
import { BarOrderSelect } from "@/components/BarOrderSelect";
import { useBarOrder } from "@/hooks/useBarOrder";
import { rankingOf, rankQueryDays, windowDayCount } from "@/utils/barOrder";


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
    // Clamped on the way in rather than after mount: a `days` straight from
    // the URL gets one query and one chart padded to it before anything
    // downstream could correct it.
    days: parseDaysParam(p.get("days"), resolvedEndDate(parseDate(p.get("date")), "Europe/Moscow")),
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
  const { loadState, error, queryDaily, querySources, queryRegions, queryGlobalStats, queryDataWindow } = useRuModDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  // Mounted only while on: mounting the strip is what fetches its DB.
  const [showWeather, setShowWeather] = useWeatherStripPref();
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<RuAdDailyRow[]>([]);
  const [sources, setSources] = useState<Map<string, SheetSource[]>>(new Map());
  const [regions, setRegions] = useState<Map<string, Record<"night" | "day", RegionMention[]>>>(new Map());
  const [globalStats, setGlobalStats] = useState<RuAdGlobalStats>(() => {
    const zero = { max: 0, median: 0, total: 0 };
    return { total: zero, night: zero, day: zero };
  });
  const [hasData, setHasData] = useState(false);
  const [order, setOrder] = useBarOrder();

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
    const capped = clampDays(days, resolvedEndDate(d, "Europe/Moscow"));
    setDays(capped);
    setUrlParams({ date: d, days: String(capped) });
  };
  const updateWeekdays = (next: number[]) => {
    setSelectedWeekdays(next);
    setUrlParams({ weekdays: next.join(",") });
  };

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  // Ranked, every day from the first up to the window's end (utils/barOrder).
  const endDate = resolvedEndDate(selectedDate, "Europe/Moscow");
  const queryDays = rankQueryDays(order, days, endDate, dataWindow.minDate);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(queryDays, selectedDate || undefined));
      setSources(querySources(queryDays, selectedDate || undefined));
      setRegions(queryRegions(queryDays, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, queryDays, selectedDate, queryDaily, querySources, queryRegions, refreshKey]);

  const todayDow = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" }) + "T12:00:00").getDay();
  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });

  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Moscow").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate || next < WINDOW_FLOOR) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;
  // "live" sits at today, so there is always a day behind it.
  const canGoPrev = selectedDate === "" || selectedDate > WINDOW_FLOOR;

  const filteredRows = useMemo(() => filterDailyRows(rows, { selectedDate, days: queryDays, weekdays: selectedWeekdays }), [rows, selectedWeekdays, selectedDate, queryDays]);

  const startDate = windowStartDate(endDate, days);
  const dataStart = windowStartDate(endDate, queryDays);
  // When a weekday filter is on, the chart deliberately drops other weekdays;
  // the fill must respect that so padding doesn't reintroduce them as gap rows.
  const keepDate = weekdayPredicate(selectedWeekdays);
  // Compose the tooltip note from the per-report DB caveats (already prefixed
  // with the report's HH:MM→HH:MM window in queryDaily) so the reader sees
  // exactly which window(s) are flagged, and why — a possible double-count from
  // overlapping windows, or an air-target report that isn't purely UAVs.
  const caveatForKey = (d: RuAdDailyRow, key: "total" | "night" | "day") => {
    const note = key === "total" ? d.caveat_note_total : key === "night" ? d.caveat_note_night : d.caveat_note_day;
    return note ?? undefined;
  };
  // The regions the day's reports named: all of them under the total, each
  // window's under its own line — or, ranked, under its own chart.
  const { totalRegions, windowRegions, nightRegions, dayRegions } = useMemo(() => {
    const totalRegions = new Map<string, ReactNode>();
    const windowRegions = new Map<string, ReactNode>();
    const nightRegions = new Map<string, ReactNode>();
    const dayRegions = new Map<string, ReactNode>();
    for (const [date, { night, day }] of regions) {
      const all = regionList([...night, ...day]);
      if (all) totalRegions.set(date, <RuModRegionList list={all} />);
      const nightList = regionList(night);
      const dayList = regionList(day);
      if (nightList) nightRegions.set(date, <RuModRegionList list={nightList} />);
      if (dayList) dayRegions.set(date, <RuModRegionList list={dayList} />);
      const windows = ([["Overnight", nightList], ["Daytime", dayList]] as const)
        .flatMap(([label, list]) => (list ? [<RuModRegionList key={label} label={label} list={list} />] : []));
      if (windows.length) windowRegions.set(date, <>{windows}</>);
    }
    return { totalRegions, windowRegions, nightRegions, dayRegions };
  }, [regions]);
  const makeDataset = (key: "total" | "night" | "day") =>
    fillDailyRange(
      filteredRows.map((d) => ({
        date: d.date,
        value: d[key],
        is_today: d.is_today,
        note: caveatForKey(d, key),
      })),
      dataStart,
      endDate,
      { keepDate },
    );

  const ranking = rankingOf(order, windowDayCount(endDate, days, keepDate));

  return (
    <PageScaffold
      headerVariant="block"
      title={siteTitle("ru-airdef-mod", "Daily")}
      description={<>
        Russian MoD air-defense intercept claims · source: @mod_russia (Telegram) · per drone-day (MSK)
        <br />
        <span style={{ color: t.textImportant, border: `2px solid ${t.borderImportant}`, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4 }}>
          Russian MoD reports of UAVs intercepted/downed over Russia — a floor for the number launched, not a launch count. A day aggregates the overnight report (20:00 prev → 07:00) plus that day's daytime windows.
        </span>
      </>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-mod" />}
      controls={<>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} endDate={endDate} />
        <DateNav label="End" value={selectedDate} min={WINDOW_FLOOR} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} canGoPrev={canGoPrev} />
        <BarOrderSelect value={order} onChange={setOrder} />
        <MoreControls>
          <WindowStartNav value={days} onChange={updateDays} endDate={endDate} minDate={dataWindow.minDate ?? undefined} />
          <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
          <StatScopeToggle />
          <WeatherToggle checked={showWeather} onChange={setShowWeather} />
        </MoreControls>
      </>}
      ranking={ranking}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading RU air-defense database…"
      gridChildren={<>
        {showWeather && <WeatherStripDaily key="weather" startDate={startDate} endDate={endDate} />}
        <DailyLineChart
          title={RU_MOD_DAILY_TOTAL_TITLE}
          data={makeDataset("total")}
          globalMax={globalStats.total.max}
          globalMedian={globalStats.total.median}
          globalTotal={globalStats.total.total}
          wfull
          sourcesByDate={sources}
          detailByDate={totalRegions}
        />
        <DailyMultiLineChart
          title={RU_MOD_DAILY_WINDOWS_TITLE}
          series={[
            { key: "night", label: "Overnight", color: chartColors(t).overnight, data: makeDataset("night"),
              globalMax: globalStats.night.max, globalMedian: globalStats.night.median, globalTotal: globalStats.night.total },
            { key: "day", label: "Daytime", color: chartColors(t).daytime, data: makeDataset("day"),
              globalMax: globalStats.day.max, globalMedian: globalStats.day.median, globalTotal: globalStats.day.total },
          ]}
          wfull
          sourcesByDate={sources}
          detailByDate={windowRegions}
          rankable
          rankedTitles={{ night: "Overnight Reports", day: "Daytime Reports" }}
          rankedDetail={{ night: nightRegions, day: dayRegions }}
        />
      </>}
    />
  );
}
