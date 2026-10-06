import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useGsuaDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DailyMultiLineChart, type LineSeries } from "@/components/DailyMultiLineChart";
import { CheckboxMultiSelect } from "@/components/CheckboxMultiSelect";
import { axisLabel, axisSeries, directionColor, directionOptions, directionsTitle, parseDirectionsParam } from "@/utils/gsuaDirections";
import { DirectionCoverageChart } from "@/components/DirectionCoverageChart";
import { DataWindow } from "@/components/DataWindow";
import { ChartGrid } from "@/components/Layout";
import { PageScaffold } from "@/components/PageScaffold";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam, clampDays, WINDOW_FLOOR, filterDailyRows, weekdayPredicate } from "@/utils/dayRange";
import { fillDailyRange, resolvedEndDate } from "@/utils/padTrailing";
import { interimNote } from "@/utils/gsuaInterim";
import {
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  type GsuaDailyRow,
  type GsuaDirectionCoverageRow,
  type GsuaGlobalStats,
  type GsuaMetricKey,
  type EodEstimate,
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
    directions: parseDirectionsParam(p.get("direction")),
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

export function GsuaDailyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const {
    loadState, error, queryDaily, queryGlobalStats, queryEodProjection,
    queryDirectionList, queryDirectionCoverage, queryDataWindow,
  } = useGsuaDatabaseContext();
  const [dataWindow, setDataWindow] = useState<{ minDate: string | null; maxDate: string | null; latestSnapshotAt: string | null }>({ minDate: null, maxDate: null, latestSnapshotAt: null });
  useEffect(() => { queryDataWindow().then(setDataWindow); }, [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [selectedDirections, setSelectedDirections] = useState<string[]>(initial.directions);

  const [rows, setRows] = useState<GsuaDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GsuaGlobalStats>({} as GsuaGlobalStats);
  const [directionList, setDirectionList] = useState<string[]>([]);
  const [coverageRows, setCoverageRows] = useState<GsuaDirectionCoverageRow[]>([]);
  const [eod, setEod] = useState<Partial<Record<GsuaMetricKey, EodEstimate>>>({});
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
  const updateDirections = (dirs: string[]) => {
    setSelectedDirections(dirs);
    setUrlParams({ direction: dirs.join(",") });
  };

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const [dl, ep] = await Promise.all([queryDirectionList(), queryEodProjection()]);
      if (cancelled) return;
      setDirectionList(dl);
      setEod(ep);
    })();
    return () => { cancelled = true; };
  }, [loadState, queryDirectionList, queryEodProjection, refreshKey]);

  // Whole-history MAX / MED / TOTAL, which the charts read only under the "All
  // data" stat scope — the default is "Window data". Over httpvfs it is the
  // whole history's daily rows (~110 pages), so it waits until it is used.
  const { scope } = useStatScope();
  useEffect(() => {
    if (loadState !== "ready" || scope !== "all") return;
    let cancelled = false;
    queryGlobalStats().then((gs) => { if (!cancelled) setGlobalStats(gs); });
    return () => { cancelled = true; };
  }, [loadState, scope, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const daily = await queryDaily(days, selectedDate || undefined);
      if (cancelled) return;
      setRows(daily);
      // The coverage rows serve both views: the stack in the overview, and a
      // picked direction's own figure, which is its share of the same stack.
      const cov = await queryDirectionCoverage(days, selectedDate || undefined);
      if (cancelled) return;
      setCoverageRows(cov);
      setHasData(true);
    })();
    return () => { cancelled = true; };
  }, [loadState, days, selectedDate, queryDaily, queryDirectionCoverage, refreshKey]);

  const todayDow = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00").getDay();
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

  const filteredRows = useMemo(() => filterDailyRows(rows, { selectedDate, days, weekdays: selectedWeekdays }), [rows, selectedDate, selectedWeekdays, days]);

  const filteredCoverageRows = useMemo(() => filterDailyRows(coverageRows, { selectedDate, days, weekdays: selectedWeekdays }), [coverageRows, selectedDate, selectedWeekdays, days]);


  const endDate = resolvedEndDate(selectedDate);
  const startDate = windowStartDate(endDate, days);
  // Weekday filter is intentional — don't pad dates that the user filtered out.
  const keepDate = weekdayPredicate(selectedWeekdays);
  const makeDataset = (key: GsuaMetricKey) =>
    fillDailyRange(
      filteredRows.map((d) => ({
        date: d.date,
        value: typeof d[key] === "number" ? (d[key] as number) : null,
        is_today: d.is_today,
        note: interimNote(d.date, d.snapshot_at),
      })),
      startDate,
      endDate,
      { keepDate },
    );

  // For the combat_engagements chart in overview mode: show `attributed`
  // (sum of per-direction attacks for the canonical daily report) as a
  // stacked subset of the total. The chart's pairMode="subset" then draws
  // the "unattributed" band as `combat_engagements − attributed` on top,
  // so the reader sees at a glance how big the directionless portion is.
  // Note: paired-direction over-attribution ("На X і Y напрямках N ...")
  // inflates `attributed` on ~75% of days, so the unattributed band is a
  // conservative lower bound of the true directionless share.
  const attributedDataset = fillDailyRange(
    filteredCoverageRows.map((d) => ({
      date: d.date,
      value: d.attributed,
      is_today: d.is_today,
    })),
    startDate,
    endDate,
    { keepDate },
  );

  // A picked direction's attacks: its share of the coverage stack (see
  // utils/gsuaDirections.ts), filtered and padded like the overview's.
  const directionDataset = (axis: string) =>
    fillDailyRange(
      axisSeries(filteredCoverageRows, axis, (r) => interimNote(r.date, r.snapshot_at)),
      startDate,
      endDate,
      { keepDate },
    );
  // Window MAX / MED / TOTAL for the one-direction charts, which have no
  // whole-dataset stats of their own.
  const windowStats = (data: { value: number | null }[]) => {
    const vals = data.map((p) => p.value).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    return {
      max: vals.length ? vals[vals.length - 1] : 0,
      median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
      total: vals.reduce((s, n) => s + n, 0),
    };
  };
  const directionSeries = (): LineSeries[] =>
    selectedDirections.map((axis) => ({
      key: axis, label: axisLabel(axis), color: directionColor(directionList, axis, selectedDirections), data: directionDataset(axis),
    }));
  const directionTitle = directionsTitle(selectedDirections);
  const oneDirection = selectedDirections.length === 1 ? selectedDirections[0] : null;

  return (
    <PageScaffold
      headerVariant="block"
      title={`Daily Combat Stats ${selectedDirections.length ? `— ${directionTitle}` : ""} - GSUA`}
      description={<>
        Last snapshot per day · Parsed deterministically from Telegram <a href="https://t.me/GeneralStaffZSU" rel="nofollow external" target="_blank">@GeneralStaffZSU</a>. May be incomplete or incorrect.
        <br/>
        <span style={{ color: t.textImportant, border: `2px solid ${t.borderImportant}`, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4 }}>
          A day's figures are final with the General Staff's wrap-up report the next morning (08:00). Until then they come from that day's interim report (at 22:00). Before 4 Aug there was also an afternoon report, usually at 16:00.
        </span>
      </>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="gsua" latestSnapshotAt={dataWindow.latestSnapshotAt} />}
      controls={<>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} endDate={endDate} minDate={dataWindow.minDate ?? undefined} />
        <DateNav label="End" value={selectedDate} min={WINDOW_FLOOR} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} canGoPrev={canGoPrev} />
        <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
        <CheckboxMultiSelect
          label="Direction"
          testId="direction-picker"
          allLabel="All Ukraine (overview)"
          options={directionOptions(directionList)}
          selected={selectedDirections}
          onChange={updateDirections}
        />
        <StatScopeToggle />
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading GSUA database…"
    >
      {selectedDirections.length === 0 && (
        <ChartGrid>
          {GSUA_METRIC_KEYS.map((k) => {
            // The combat_engagements chart gets the attributed/unattributed
            // stacked split when coverage data is available; other metrics
            // render as plain single-series line charts unchanged.
            const isCombat = k === "combat_engagements";
            const pair = isCombat && filteredCoverageRows.length > 0;
            return (
              <DailyLineChart
                key={k}
                title={GSUA_METRIC_LABELS[k]}
                data={makeDataset(k)}
                globalMax={globalStats[k]?.max ?? 0}
                globalMedian={globalStats[k]?.median ?? 0}
                globalTotal={globalStats[k]?.total ?? 0}
                wfull={isCombat}
                eod={eod[k] ?? null}
                data2={pair ? attributedDataset : undefined}
                primaryLabel={pair ? "Unattributed" : undefined}
                label2={pair ? "With direction" : undefined}
                pairMode={pair ? "subset" : undefined}
                // The top area labelled "Unattributed" is the diff between
                // combat_engagements (data) and attributed (data2), NOT the
                // raw `data` value. Tell the tooltip to show that explicitly:
                // Total, With direction, Unattributed as three separate rows.
                primaryIsDiff={pair ? true : undefined}
              />
            );
          })}
          {filteredCoverageRows.length > 0 && (
            <DirectionCoverageChart data={filteredCoverageRows} wfull />
          )}
        </ChartGrid>
      )}
      {oneDirection && (() => {
        const attacks = directionDataset(oneDirection);
        const sa = windowStats(attacks);
        return (
          <ChartGrid>
            <DailyLineChart
              title={`Attacks · ${axisLabel(oneDirection)}`}
              data={attacks}
              globalMax={sa.max}
              globalMedian={sa.median}
              globalTotal={sa.total}
              wfull
            />
          </ChartGrid>
        );
      })()}
      {/* Several directions: overlaid, one line each, to compare them. */}
      {selectedDirections.length > 1 && (
        <ChartGrid>
          <DailyMultiLineChart title="Attacks by direction" series={directionSeries()} wfull />
        </ChartGrid>
      )}
    </PageScaffold>
  );
}
