import { useEffect, useMemo, useState } from "react";
import { useGsuaDatabaseContext } from "@/context/databases";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DirectionCoverageChart } from "@/components/DirectionCoverageChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { CheckboxMultiSelect } from "@/components/CheckboxMultiSelect";
import { DailyMultiLineChart, type LineSeries } from "@/components/DailyMultiLineChart";
import { sumByMonth } from "@/utils/monthlySum";
import { directionColor, directionOptions, directionsTitle, parseDirectionsParam } from "@/utils/gsuaDirections";
import { getKyivDateString } from "@/hooks/sqlLoader";
import { maxMedian } from "@/utils/windowStats";
import {
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  type GsuaMetricKey,
  type GsuaMonthlyRow,
  type GsuaDirectionCoverageRow,
  type GsuaDirectionRow,
  type MonthlyDataPoint,
} from "@/types";

interface Props {
  refreshKey?: number;
}

// Every day since the data began — a direction's monthly figure is summed from
// its daily ones (there is no monthly query per direction), over the whole
// history so the stat scope's "all data" and the month-range slice both work.
const ALL_DAYS = 100_000;

function setDirectionParam(dirs: string[]) {
  const p = new URLSearchParams(window.location.search);
  if (dirs.length) p.set("direction", dirs.join(","));
  else p.delete("direction");
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

export function GsuaMonthlyPage({ refreshKey }: Props) {
  const {
    loadState, error, queryMonthly, queryDirectionCoverageMonthly, queryDataWindow,
    queryDirectionList, queryDirectionDaily,
  } = useGsuaDatabaseContext();
  const [dataWindow, setDataWindow] = useState<{ minDate: string | null; maxDate: string | null; latestSnapshotAt: string | null }>({ minDate: null, maxDate: null, latestSnapshotAt: null });
  useEffect(() => { queryDataWindow().then(setDataWindow); }, [queryDataWindow]);
  const [allRows, setAllRows] = useState<GsuaMonthlyRow[]>([]);
  const [coverageRows, setCoverageRows] = useState<GsuaDirectionCoverageRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const [directionList, setDirectionList] = useState<string[]>([]);
  const [selectedDirections, setSelectedDirections] = useState<string[]>(
    () => parseDirectionsParam(new URLSearchParams(window.location.search).get("direction")),
  );
  const [directionRows, setDirectionRows] = useState<Record<string, GsuaDirectionRow[]>>({});
  const updateDirections = (dirs: string[]) => {
    setSelectedDirections(dirs);
    setDirectionParam(dirs);
  };
  const directionsKey = selectedDirections.join(",");
  const yr = useMonthlyMonthRange(allRows.length);
  const rows = useMemo(() => yr.slice(allRows), [allRows, yr]);

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const [monthly, coverage, list] = await Promise.all([
        queryMonthly(),
        queryDirectionCoverageMonthly(),
        queryDirectionList(),
      ]);
      if (cancelled) return;
      setAllRows(monthly);
      setCoverageRows(coverage);
      setDirectionList(list);
      setHasData(true);
    })();
    return () => { cancelled = true; };
  }, [loadState, queryMonthly, queryDirectionCoverageMonthly, queryDirectionList, refreshKey]);

  useEffect(() => {
    if (loadState !== "ready") return;
    const dirs = directionsKey ? directionsKey.split(",") : [];
    let cancelled = false;
    (async () => {
      const perDir = await Promise.all(dirs.map((d) => queryDirectionDaily(d, ALL_DAYS)));
      if (cancelled) return;
      setDirectionRows(Object.fromEntries(dirs.map((d, i) => [d, perDir[i]])));
    })();
    return () => { cancelled = true; };
  }, [loadState, directionsKey, queryDirectionDaily, refreshKey]);

  // Coverage rows are keyed by "YYYY-MM"; filter to the same year-range slice
  // the metric grid uses so the two views agree on what's shown.
  const filteredCoverageRows = useMemo(() => {
    if (rows.length === 0) return coverageRows;
    const months = new Set(rows.map((r) => r.date));
    return coverageRows.filter((r) => months.has(r.date));
  }, [coverageRows, rows]);

  // Whole-dataset stats per metric, from un-sliced rows so the "all" stat
  // scope reflects the full history (not just the year-range window).
  const allStats = useMemo(() => {
    const out: Record<string, { max: number; median: number; total: number }> = {};
    for (const k of GSUA_METRIC_KEYS) {
      out[k] = maxMedian(allRows.map((r) => (typeof r[k] === "number" ? r[k] : null)));
    }
    return out;
  }, [allRows]);

  const endMonth = resolvedEndMonth();
  const makeDataset = (key: GsuaMetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
      rows.map((d) => {
        const value = typeof d[key] === "number" ? d[key] : null;
        const projected = d[`${key}_projected`];
        return {
          date: d.date,
          value,
          gap: projected != null && value != null ? projected - value : undefined,
          projected,
          projection_day: d.projection_day ?? undefined,
          projection_days_in_month: d.projection_days_in_month ?? undefined,
          projection_partial_day: d.projection_partial_day,
        };
      }),
      endMonth,
    );

  // A direction's months, cut to the same month-range slice as the rest.
  const today = getKyivDateString();
  const shownMonths = new Set(rows.map((r) => r.date));
  const directionMonths = (dir: string, which: "attacks" | "ongoing") =>
    sumByMonth((directionRows[dir] ?? []).map((d) => ({ date: d.date, value: d[which] })), today);
  const inSlice = <T extends { date: string }>(pts: T[]) =>
    shownMonths.size ? pts.filter((p) => shownMonths.has(p.date)) : pts;
  const oneDirection = selectedDirections.length === 1 ? selectedDirections[0] : null;
  const directionSeries = (which: "attacks" | "ongoing"): LineSeries[] =>
    selectedDirections.map((dir) => ({
      key: dir, label: dir, color: directionColor(directionList, dir, selectedDirections),
      data: inSlice(directionMonths(dir, which)),
    }));
  const directionBarChart = (dir: string, which: "attacks" | "ongoing", title: string) => {
    const all = directionMonths(dir, which);
    const stats = maxMedian(all.map((p) => p.value));
    return (
      <MonthlyBarChart
        key={`${dir}-${which}`}
        title={title}
        data={padTrailingMonthly(inSlice(all).map((p) => ({ date: p.date, value: p.value, note: p.note })), endMonth)}
        wfull={false}
        globalMax={stats.max}
        globalMedian={stats.median}
        globalTotal={stats.total}
      />
    );
  };

  return (
    <PageScaffold
      title={`Monthly Combat Stats ${selectedDirections.length ? `— ${directionsTitle(selectedDirections)} ` : ""}- GSUA`}
      description={<>Monthly sums of daily totals from Ukrainian General Staff reports. Current month shows end-of-month projection. Parsed deterministically from Telegram <a href="https://t.me/GeneralStaffZSU" rel="nofollow external" target="_blank">@GeneralStaffZSU</a>. May be incomplete or incorrect.</>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="gsua" latestSnapshotAt={dataWindow.latestSnapshotAt} />}
      // No window picker → no scope toggle either; see StatScopeToggle.
      controls={<>
        {!yr.hidden && <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />}
        <CheckboxMultiSelect
          label="Direction"
          testId="direction-picker"
          allLabel="All Ukraine (overview)"
          options={directionOptions(directionList)}
          selected={selectedDirections}
          onChange={updateDirections}
        />
        {!yr.hidden && <StatScopeToggle />}
      </>}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading GSUA database…"
      gridChildren={<>
        {selectedDirections.length === 0 && (<>
        {GSUA_METRIC_KEYS.map((k) => (
          <MonthlyBarChart
            key={k}
            title={GSUA_METRIC_LABELS[k]}
            data={makeDataset(k)}
            wfull={k === "combat_engagements"}
            globalMax={allStats[k]?.max ?? 0}
            globalMedian={allStats[k]?.median ?? 0}
            globalTotal={allStats[k]?.total ?? 0}
          />
        ))}
        {filteredCoverageRows.length > 0 && (
          <DirectionCoverageChart
            data={filteredCoverageRows}
            wfull
            granularity="monthly"
          />
        )}
        </>)}
        {oneDirection && (<>
          {directionBarChart(oneDirection, "attacks", `Attacks · ${oneDirection}`)}
          {directionBarChart(oneDirection, "ongoing", `Ongoing engagements · ${oneDirection}`)}
        </>)}
        {/* Several: side by side per month, not summed — see the daily page. */}
        {selectedDirections.length > 1 && (<>
          <DailyMultiLineChart title="Attacks by direction" series={directionSeries("attacks")} granularity="monthly" style="bar" wfull />
          <DailyMultiLineChart title="Ongoing engagements by direction" series={directionSeries("ongoing")} granularity="monthly" style="bar" wfull />
        </>)}
      </>}
    />
  );
}
