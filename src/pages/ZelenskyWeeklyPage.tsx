import { useEffect, useMemo, useState } from "react";
import { useZelenskyWeeklyDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { PageScaffold } from "@/components/PageScaffold";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { MoreControls } from "@/components/MoreControls";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { maxMedian } from "@/utils/windowStats";
import {
  ZELENSKY_CATEGORIES,
  ZELENSKY_CATEGORY_LABELS,
  type MonthlyDataPoint,
  type ZelenskyCategory,
  type ZelenskyWeekRow,
} from "@/types";
import {
  formatHedged, formatWeekRange, formatWeekTick, mondaysBetween, monthsSpanned, toWeeklyDataset,
  weeklySources, weeksInMonthWindow, windowTicks,
} from "@/utils/zelenskyWeekly";

interface Props {
  refreshKey?: number;
}

const CHANNEL_URL = "https://t.me/V_Zelenskiy_official";
// Sources are keyed by the week's Monday, the bar's own date.
const weekKey = (date: string) => date;

export function ZelenskyWeeklyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryWeeks } = useZelenskyWeeklyDatabaseContext();
  const [rows, setRows] = useState<ZelenskyWeekRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryWeeks());
      setHasData(true);
    }
  }, [loadState, queryWeeks, refreshKey]);

  // Every week from the first tally to the last, so the months without one
  // show as gaps instead of being closed up.
  const allMondays = useMemo(
    () => (rows.length ? mondaysBetween(rows[0].period_start, rows[rows.length - 1].period_start) : []),
    [rows],
  );
  const first = rows[0]?.period_start;
  const last = rows[rows.length - 1]?.period_end;

  // The monthly pages' time window (months + end month, default 12 months),
  // over the weeks whose Monday falls in it. Counted in calendar months, so
  // the picker shows once the series spans more than a year.
  const yr = useMonthlyMonthRange({
    count: first && last ? monthsSpanned(first, last) : 0,
    first: first ?? "",
  });
  const mondays = useMemo(
    () => (yr.hidden ? allMondays : weeksInMonthWindow(allMondays, yr.months, yr.endMonth)),
    [allMondays, yr.hidden, yr.months, yr.endMonth],
  );
  const ticks = useMemo(() => windowTicks(mondays), [mondays]);
  const byMonday = useMemo(() => new Map(rows.map((r) => [r.period_start, r])), [rows]);
  // The post behind each week, linked from a pinned bar's sheet.
  const sources = useMemo(() => weeklySources(rows), [rows]);
  // Whole-series stats, for the "all" stat scope; the window's own are the
  // chart's default.
  const allStats = useMemo(
    () => Object.fromEntries(ZELENSKY_CATEGORIES.map((k) => [k, maxMedian(rows.map((r) => r[k]))])) as
      Record<ZelenskyCategory, ReturnType<typeof maxMedian>>,
    [rows],
  );

  // Tooltip header: the week spelled out, plus the figure as the post hedged
  // it — the bar height alone would present "понад 3170" as exactly 3,170.
  const headerFor = (category: ZelenskyCategory) => (d: MonthlyDataPoint) => {
    const r = byMonday.get(d.date);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span>{formatWeekRange(d.date)}</span>
        <span style={{ fontSize: 10, color: t.textMuted }}>
          {r
            ? <>{r.period} · as posted: {formatHedged(r[category], r[`${category}_bound`])}</>
            : "no weekly tally posted"}
        </span>
      </div>
    );
  };

  return (
    <PageScaffold
      title="Weekly Russian Strikes — President of Ukraine"
      descriptionStyle={{ maxWidth: 900, lineHeight: 1.55 }}
      description={<>
        Russian strike drones, guided aerial bombs (KAB) and missiles launched at Ukraine each
        week, as totalled in the President's weekly post on his
        {" "}
        <a href={CHANNEL_URL} rel="nofollow external">Telegram channel</a>.
        {" "}
        The figures are <em>rounded</em>, and most are hedged («понад» over, «майже» almost,
        «близько» about); the tooltip shows each one as posted.
        {" "}
        Posts say only "this week" or "last week", so the dates are worked out from when
        each post went up (Monday–Sunday, Kyiv time).
        {" "}
        Click a week to pin it and link the post its figures come from.
        {" "}
        Empty weeks had no weekly tally. Through most of Apr–Sep 2025 the President posted
        month-to-date totals instead, which are not shown here.
      </>}
      // No window picker → no scope toggle either; see StatScopeToggle.
      controls={yr.hidden ? undefined : (
        <>
          <MonthWindowControls yr={yr} min={first ?? ""} />
          <MoreControls>
            <StatScopeToggle />
          </MoreControls>
        </>
      )}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading weekly strike tallies…"
      gridChildren={<>
        {ZELENSKY_CATEGORIES.map((k) => (
          <MonthlyBarChart
            key={k}
            title={ZELENSKY_CATEGORY_LABELS[k]}
            data={toWeeklyDataset(rows, k, mondays)}
            wfull
            formatTick={formatWeekTick}
            xTicks={ticks}
            formatHeader={headerFor(k)}
            explainGaps
            globalMax={allStats[k].max}
            globalMedian={allStats[k].median}
            globalTotal={allStats[k].total}
            sourcesByDate={sources}
            sourceKey={weekKey}
          />
        ))}
      </>}
    />
  );
}
