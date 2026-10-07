import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useCitCiviliansDatabaseContext } from "@/context/databases";
import { CitDailyBarChart, type CitDailyBarRow } from "@/components/CitDailyBarChart";
import { CitTerritoryChart } from "@/components/CitTerritoryChart";
import { DataWindow } from "@/components/DataWindow";
import { PageScaffold } from "@/components/PageScaffold";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import {
  DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam, clampDays, WINDOW_FLOOR,
} from "@/utils/dayRange";
import {
  CIT_METRIC_LABELS,
  type CitDailyRow,
  type CitGlobalStats,
  type CitTerritoryDailyRow,
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
  const { loadState, error, queryDaily, queryTerritoryDaily, queryGlobalStats, queryDataWindow } =
    useCitCiviliansDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<CitDailyRow[]>([]);
  const [territory, setTerritory] = useState<CitTerritoryDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<CitGlobalStats>({} as CitGlobalStats);
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

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(days, selectedDate || undefined));
      setTerritory(queryTerritoryDaily(days, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryDaily, queryTerritoryDaily, refreshKey]);

  const maxSelectableDate = mskToday();
  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Moscow").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate || next < WINDOW_FLOOR) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;
  // "live" sits at today, so there is always a day behind it.
  const canGoPrev = selectedDate === "" || selectedDate > WINDOW_FLOOR;

  const endDate = selectedDate || maxSelectableDate;
  const startDate = windowStartDate(endDate, days);

  // One row per day of the window. queryDaily has already spread a weekend
  // report over its two days; a day no report covers becomes a gap, not a 0.
  const bars = useMemo((): CitDailyBarRow[] => {
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const out: CitDailyBarRow[] = [];
    for (let d = Temporal.PlainDate.from(startDate); d.toString() <= endDate; d = d.add({ days: 1 })) {
      const r = byDate.get(d.toString());
      out.push(r
        ? { date: r.date, report_date: r.report_date, window_days: r.window_days,
            killed: r.killed, injured: r.injured }
        : { date: d.toString(), report_date: null, window_days: 1, killed: null, injured: null });
    }
    return out;
  }, [rows, startDate, endDate]);

  return (
    <PageScaffold
      headerVariant="block"
      title="Daily civilian casualties - CIT"
      description={<>Civilians killed and injured in Ukraine and Russia, compiled daily by the Conflict Intelligence Team from official statements · source: <a href="https://t.me/CIT_shellings" rel="nofollow external" target="_blank">@CIT_shellings</a></>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="cit" />}
      controls={<>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
        <DateNav label="End" value={selectedDate} min={WINDOW_FLOOR} max={maxSelectableDate}
                 onChange={updateDate} onShift={shiftSelectedDate}
                 canGoNext={canGoNext} canGoPrev={canGoPrev} />
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading CIT civilian-casualties database…"
      gridChildren={<>
        {/* Killed + injured as one stacked total. The two are disjoint, so
            they sum; killed sits at the bottom of the stack, anchored to the
            baseline, which is the only place a band that small stays
            readable against an injured count roughly six times larger. */}
        <CitDailyBarChart title="All civilian casualties" data={bars}
                          series={["killed", "injured"]} globalStats={globalStats} wfull />
        <CitDailyBarChart title={CIT_METRIC_LABELS.killed} data={bars}
                          series={["killed"]} globalStats={globalStats} wfull />
        <CitDailyBarChart title={CIT_METRIC_LABELS.injured} data={bars}
                          series={["injured"]} globalStats={globalStats} wfull />
        <CitTerritoryChart
          data={territory}
          wfull
          caveat={<>Killed + injured, from each report's per-region lines — accurate to about a percent in aggregate, but rarely to the person on a given day. A double-width bar is one weekend report spanning its two days, at the daily average.</>}
        />
      </>}
    />
  );
}
