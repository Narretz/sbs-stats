import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useCitCiviliansDatabaseContext } from "@/context/databases";
import { CitHeadlineChart, type CitDailyBarRow } from "@/components/CitHeadlineChart";
import { CitTerritoryChart } from "@/components/CitTerritoryChart";
import { DataWindow } from "@/components/DataWindow";
import { PageScaffold } from "@/components/PageScaffold";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { MoreControls } from "@/components/MoreControls";
import { WeatherStripDaily } from "@/components/WeatherStripDaily";
import { WeatherToggle } from "@/components/WeatherToggle";
import { useWeatherStripPref } from "@/hooks/useWeatherStripPref";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { BarOrderSelect } from "@/components/BarOrderSelect";
import { useBarOrder } from "@/hooks/useBarOrder";
import { isReportRow } from "@/components/spanBarShape";
import { rankingOf, rankQueryDays } from "@/utils/barOrder";
import {
  DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam, clampDays, WINDOW_FLOOR,
} from "@/utils/dayRange";
import { maxMedian } from "@/utils/windowStats";
import { daysBetween } from "@/utils/padTrailing";
import { stackTotal } from "@/utils/citTerritory";
import type { SheetSource } from "@/components/TooltipTable";
import {
  type CitDailyRow,
  type CitGlobalStats,
  type CitTerritoryDailyRow,
  type Stat,
  siteTitle,
} from "@/types";

function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const date = parseDate(p.get("date"));
  return { days: parseDaysParam(p.get("days"), date || undefined), date };
}

function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === "") p.delete(k);
    else p.set(k, v);
  }
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

// CIT reports on Moscow time, so "today" and the date picker's ceiling are the
// Moscow date — the same basis as the 20:00–20:00 MSK window itself.
function mskToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
}

interface Props {
  refreshKey?: number;
}

export function CitCiviliansDailyPage({ refreshKey }: Props) {
  const { loadState, error, queryDaily, queryTerritoryDaily, querySources, queryGlobalStats, queryDataWindow } =
    useCitCiviliansDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  // Mounted only while on: mounting the strip is what fetches its DB.
  const [showWeather, setShowWeather] = useWeatherStripPref();
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<CitDailyRow[]>([]);
  const [territory, setTerritory] = useState<CitTerritoryDailyRow[]>([]);
  const [sources, setSources] = useState<Map<string, SheetSource[]>>(new Map());
  const [globalStats, setGlobalStats] = useState<CitGlobalStats>({} as CitGlobalStats);
  const [territoryStats, setTerritoryStats] = useState<{ all?: Stat }>({});
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => {
    const clamped = clampDays(d, selectedDate || maxSelectableDate);
    setDays(clamped);
    setUrlParams({ days: String(clamped) });
  };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  // The controlling-side chart's median line in the "all" scope: every day
  // since the first report, on the bars' own per-day basis.
  useEffect(() => {
    if (loadState !== "ready" || !dataWindow.minDate) return;
    const today = mskToday();
    const span = Temporal.PlainDate.from(dataWindow.minDate).until(Temporal.PlainDate.from(today)).days + 1;
    const all = queryTerritoryDaily(span, today);
    setTerritoryStats({ all: maxMedian(all.map((r) => stackTotal(r, ["uaControlled", "ruControlled"] as const))) });
  }, [loadState, dataWindow.minDate, queryTerritoryDaily, refreshKey]);

  // Ranked, every day from the first up to the window's end (utils/barOrder).
  const [order, setOrder] = useBarOrder();
  const maxSelectableDate = mskToday();
  const endDate = selectedDate || maxSelectableDate;
  const queryDays = rankQueryDays(order, days, endDate, dataWindow.minDate);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(queryDays, selectedDate || undefined));
      setTerritory(queryTerritoryDaily(queryDays, selectedDate || undefined));
      setSources(querySources(queryDays, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, queryDays, selectedDate, queryDaily, queryTerritoryDaily, querySources, refreshKey]);

  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Moscow").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate || next < WINDOW_FLOOR) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;
  // "live" sits at today, so there is always a day behind it.
  const canGoPrev = selectedDate === "" || selectedDate > WINDOW_FLOOR;

  const startDate = windowStartDate(endDate, days);
  const dataStart = windowStartDate(endDate, queryDays);
  // As many bars as the window has reports: ranked, a weekend report is one.
  const ranking = rankingOf(order, rows.filter((r) => r.date >= startDate && isReportRow(r)).length);

  // One row per day of the window. queryDaily has already spread a weekend
  // report over its two days; a day no report covers becomes a gap, not a 0.
  const bars = useMemo((): CitDailyBarRow[] => {
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const out: CitDailyBarRow[] = [];
    for (const d of daysBetween(dataStart, endDate)) {
      const r = byDate.get(d);
      out.push(r
        ? { date: r.date, report_date: r.report_date, window_days: r.window_days,
            killed: r.killed, injured: r.injured }
        : { date: d, report_date: null, window_days: 1, killed: null, injured: null });
    }
    return out;
  }, [rows, dataStart, endDate]);

  return (
    <PageScaffold
      headerVariant="block"
      title={siteTitle("cit-civilians", "Daily")}
      description={<>Civilians killed and injured in Ukraine and Russia, compiled daily by the Conflict Intelligence Team from official statements · source: <a href="https://t.me/CIT_shellings" rel="nofollow external" target="_blank">@CIT_shellings</a></>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="cit" />}
      controls={<>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
        <DateNav label="End" value={selectedDate} min={WINDOW_FLOOR} max={maxSelectableDate}
                 onChange={updateDate} onShift={shiftSelectedDate}
                 canGoNext={canGoNext} canGoPrev={canGoPrev} />
        <BarOrderSelect value={order} onChange={setOrder} />
        <MoreControls>
          <StatScopeToggle />
          <WeatherToggle checked={showWeather} onChange={setShowWeather} />
        </MoreControls>
      </>}
      ranking={ranking}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading CIT civilian-casualties database…"
      gridChildren={<>
        {showWeather && <WeatherStripDaily key="weather" startDate={startDate} endDate={endDate} />}
        <CitTerritoryChart
          data={territory}
          granularity="daily"
          globalStats={territoryStats}
          sourcesByDate={sources}
          wfull
          caveat={<>Killed + injured, from each report's per-region lines — accurate to about a percent in aggregate, but rarely to the person on a given day. A double-width bar is one weekend report spanning its two days, at the daily average.</>}
        />
        {/* Killed + injured as one stacked total. The two are disjoint, so
            they sum; killed sits at the bottom of the stack, anchored to the
            baseline, which is the only place a band that small stays
            readable against an injured count roughly six times larger. */}
        <CitHeadlineChart title="All civilian casualties" data={bars} granularity="daily" globalStats={globalStats} wfull sourcesByDate={sources} />
      </>}
    />
  );
}
