import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useCitCiviliansDatabaseContext } from "@/context/databases";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DataWindow } from "@/components/DataWindow";
import { PageScaffold } from "@/components/PageScaffold";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam } from "@/utils/dayRange";
import { fillDailyRange } from "@/utils/padTrailing";
import {
  CIT_METRIC_KEYS,
  CIT_METRIC_LABELS,
  type CitDailyRow,
  type CitGlobalStats,
  type CitMetricKey,
} from "@/types";

function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return { days: parseDaysParam(p.get("days")), date: parseDate(p.get("date")) };
}

function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === "") p.delete(k);
    else p.set(k, v);
  }
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

function fmtDayMonth(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}`;
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
  const { loadState, error, queryDaily, queryGlobalStats, queryDataWindow } =
    useCitCiviliansDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<CitDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<CitGlobalStats>({} as CitGlobalStats);
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(days, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryDaily, refreshKey]);

  const maxSelectableDate = mskToday();
  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Moscow").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;

  const endDate = selectedDate || maxSelectableDate;
  const startDate = windowStartDate(endDate, days);

  // A weekend report covers 48 hours, so its two days carry half of it each.
  // That half is an average, not a measurement — `note` makes the point render
  // as flagged and puts the report's real figures in the tooltip, so the shape
  // of the series stays readable without the number being taken literally.
  const weekendNote = (row: CitDailyRow): string | undefined => {
    const span = row.window_days;
    if (span < 2) return undefined;
    const end = Temporal.PlainDate.from(row.report_date);
    const first = end.subtract({ days: span - 1 });
    const total = (k: CitMetricKey) =>
      typeof row[k] === "number" ? Math.round((row[k] as number) * span) : null;
    return `One ${span * 24}-hour weekend report covering ${fmtDayMonth(first.toString())}–${fmtDayMonth(end.toString())}: ` +
      `${total("killed") ?? "\u2014"} killed, ${total("injured") ?? "\u2014"} injured in total. ` +
      `Shown here as a daily average \u2014 CIT did not publish a per-day split.`;
  };

  const makeDataset = (key: CitMetricKey) =>
    fillDailyRange(
      rows.map((d) => ({
        date: d.date,
        value: typeof d[key] === "number" ? (d[key] as number) : null,
        is_today: d.is_today,
        note: weekendNote(d),
      })),
      startDate,
      endDate,
    );

  return (
    <PageScaffold
      headerVariant="block"
      title="Daily civilian casualties - CIT"
      description={<>Civilians killed and injured in Ukraine and Russia, compiled daily by the Conflict Intelligence Team from official statements · source: <a href="https://t.me/CIT_shellings" rel="nofollow external" target="_blank">@CIT_shellings</a></>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="cit" />}
      controls={<>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
        <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading CIT civilian-casualties database…"
      gridChildren={<>
        {/* Killed + injured as one stacked total. The two are disjoint, so
            pairMode="sum" — killed sits at the bottom of the stack, anchored to
            the baseline, which is the only place a band that small stays
            readable against an injured count roughly six times larger. */}
        <DailyLineChart
          title="All civilian casualties"
          data={makeDataset("injured")}
          data2={makeDataset("killed")}
          pairMode="sum"
          primaryLabel={CIT_METRIC_LABELS.injured}
          label2={CIT_METRIC_LABELS.killed}
          globalMax={globalStats.injured?.max ?? 0}
          globalMedian={globalStats.injured?.median ?? 0}
          globalTotal={globalStats.injured?.total ?? 0}
          globalMax2={globalStats.killed?.max ?? 0}
          globalMedian2={globalStats.killed?.median ?? 0}
          globalTotal2={globalStats.killed?.total ?? 0}
          wfull
        />
        {CIT_METRIC_KEYS.map((k) => (
          <DailyLineChart
            key={k}
            title={CIT_METRIC_LABELS[k]}
            data={makeDataset(k)}
            globalMax={globalStats[k]?.max ?? 0}
            globalMedian={globalStats[k]?.median ?? 0}
            globalTotal={globalStats[k]?.total ?? 0}
            wfull
          />
        ))}
      </>}
    />
  );
}
