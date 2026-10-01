import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useUaLossesRuModDatabaseContext } from "@/sites/uaLossesRuMod/context";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DataWindow } from "@/components/DataWindow";
import { PageScaffold } from "@/components/PageScaffold";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam, clampDays, WINDOW_FLOOR, filterDailyRows, weekdayPredicate } from "@/utils/dayRange";
import { fillDailyRange, resolvedEndDate } from "@/utils/padTrailing";
import { armourBreakdown } from "@/utils/armourBreakdown";
import {
  UA_LOSSES_RU_MOD_METRIC_KEYS,
  UA_LOSSES_RU_MOD_METRIC_LABELS,
  type ModelBreakdownEntry,
  type UaLossesRuModDailyRow,
  type UaLossesRuModGlobalStats,
  type UaLossesRuModMetricKey,
} from "@/types";


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
    days: parseDaysParam(p.get("days"), resolvedEndDate(parseDate(p.get("date")))),
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

export function UaLossesRuModDailyPage({ refreshKey }: Props) {
  const { loadState, error, queryDaily, queryGlobalStats, queryDataWindow } = useUaLossesRuModDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<UaLossesRuModDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<UaLossesRuModGlobalStats>({} as UaLossesRuModGlobalStats);
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
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(days, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryDaily, refreshKey]);

  // The MoD's day is Moscow's.
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

  const filteredRows = useMemo(() => filterDailyRows(rows, { selectedDate, days, weekdays: selectedWeekdays }), [rows, selectedWeekdays, selectedDate, days]);

  const endDate = resolvedEndDate(selectedDate);
  const startDate = windowStartDate(endDate, days);
  // Weekday filter is intentional — don't pad dates that the user filtered out.
  const keepDate = weekdayPredicate(selectedWeekdays);
  const makeDataset = (key: UaLossesRuModMetricKey) =>
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
  // The MoD only totals tanks and armoured vehicles together; Felix's
  // itemisation splits them, in the tooltip.
  const armourByDate = useMemo(() => {
    const m = new Map<string, ModelBreakdownEntry[]>();
    for (const d of filteredRows) m.set(d.date, armourBreakdown(d.armour, d));
    return m;
  }, [filteredRows]);

  return (
    <PageScaffold
      headerVariant="block"
      title="Daily Ukrainian Losses - RU MoD claims"
      description={<>Ukrainian losses claimed by the Russian Ministry of Defence · the MoD's own running totals, diffed, each report dated to the day before (it covers the 24 hours to its morning) · compiled by John Felix (<a href="https://x.com/NedSnow2019" rel="nofollow external" target="_blank">@NedSnow2019</a>) from the MoD's reports · Russian claims, unverified</>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ua-losses-ru-mod" />}
      controls={<>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} endDate={endDate} minDate={dataWindow.minDate ?? undefined} />
        <DateNav label="End" value={selectedDate} min={WINDOW_FLOOR} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} canGoPrev={canGoPrev} />
        <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading RU MoD claims database…"
      gridChildren={UA_LOSSES_RU_MOD_METRIC_KEYS.map((k) => (
        <DailyLineChart
          key={k}
          title={UA_LOSSES_RU_MOD_METRIC_LABELS[k]}
          data={makeDataset(k)}
          globalMax={globalStats[k]?.max ?? 0}
          globalMedian={globalStats[k]?.median ?? 0}
          globalTotal={globalStats[k]?.total ?? 0}
          wfull={k === "personnel"}
          breakdownByDate={k === "armour" ? armourByDate : undefined}
        />
      ))}
    />
  );
}
