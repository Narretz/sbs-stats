import { useEffect, useMemo, useState } from "react";
import { useZelenskyWeeklyDatabaseContext } from "@/context/databases";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { PageScaffold } from "@/components/PageScaffold";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { MoreControls } from "@/components/MoreControls";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { extendMonthsTo } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import {
  ZELENSKY_CATEGORIES,
  ZELENSKY_CATEGORY_LABELS,
  type ZelenskyCategory,
  type ZelenskyWeekRow,
  siteTitle,
} from "@/types";
import { monthlySources, monthsBetween, toMonthlyDataset } from "@/utils/zelenskyWeekly";
import { BarOrderSelect } from "@/components/BarOrderSelect";
import { useBarOrder } from "@/hooks/useBarOrder";
import { rankingOf } from "@/utils/barOrder";

interface Props {
  refreshKey?: number;
}

const CHANNEL_URL = "https://t.me/V_Zelenskiy_official";

// The weekly tally rolled up into months (utils/zelenskyWeekly
// toMonthlyDataset): each week's daily average, summed over a month's days.
export function ZelenskyMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryWeeks } = useZelenskyWeeklyDatabaseContext();
  const [rows, setRows] = useState<ZelenskyWeekRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryWeeks());
      setHasData(true);
    }
  }, [loadState, queryWeeks, refreshKey]);

  const first = rows[0]?.period_start;
  const last = rows[rows.length - 1]?.period_end;
  const allMonths = useMemo(() => (first && last ? monthsBetween(first, last) : []), [first, last]);

  const yr = useMonthlyMonthRange({ count: allMonths.length, first: allMonths[0] ?? "" });
  const [order, setOrder] = useBarOrder();
  const ranking = rankingOf(order, extendMonthsTo(yr.slice(allMonths), yr.endMonth).length);
  // Up to the window's end, the months since the last tally included: a month
  // with no weekly post yet shows as such rather than being left off.
  const months = useMemo(() => extendMonthsTo(yr.view(allMonths, order), yr.endMonth), [allMonths, yr, order]);

  const sources = useMemo(() => monthlySources(rows), [rows]);
  const allStats = useMemo(
    () => Object.fromEntries(ZELENSKY_CATEGORIES.map((k) => [k, maxMedian(toMonthlyDataset(rows, k, allMonths, yr.liveMonth).map((d) => d.value))])) as
      Record<ZelenskyCategory, ReturnType<typeof maxMedian>>,
    [rows, allMonths, yr.liveMonth],
  );

  return (
    <PageScaffold
      title={siteTitle("zelensky-weekly", "Monthly")}
      descriptionStyle={{ maxWidth: 900, lineHeight: 1.55 }}
      description={<>
        Russian strike drones, guided aerial bombs (KAB) and missiles launched at Ukraine each
        month, built from the President's weekly tallies on his
        {" "}
        <a href={CHANNEL_URL} target="_blank" rel="nofollow external">Telegram channel</a>.
        {" "}
        Each week's figure is spread evenly over its seven days, so a week that spans two
        months counts towards each by its daily average. The weekly figures are rounded and
        mostly hedged («понад» over, «майже» almost); the weekly view quotes each as posted.
        {" "}
        A month with weeks missing a tally is <em>undercounted</em>; its bar is outlined, and the
        tooltip says how many of its days are covered. Through most of Apr–Sep 2025 the President posted
        month-to-date totals instead of weekly ones, which are not used here.
        {" "}
        Since late summer 2026 some weeks also say how many of the drones were
        jet-powered («реактивні»), as a count or a share; a share is turned into a count
        with that week's drone total.
      </>}
      // No window picker → no scope toggle either; see StatScopeToggle.
      controls={yr.hidden ? undefined : (
        <>
          <MonthWindowControls yr={yr} min={allMonths[0] ?? ""} />
          <MoreControls>
            <BarOrderSelect value={order} onChange={setOrder} />
            <StatScopeToggle />
          </MoreControls>
        </>
      )}
      ranking={ranking}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading weekly strike tallies…"
      gridChildren={<>
        {ZELENSKY_CATEGORIES.map((k) => (
          <MonthlyBarChart
            key={k}
            title={ZELENSKY_CATEGORY_LABELS[k]}
            data={toMonthlyDataset(rows, k, months, yr.liveMonth)}
            wfull
            globalMax={allStats[k].max}
            globalMedian={allStats[k].median}
            globalTotal={allStats[k].total}
            sourcesByDate={sources}
          />
        ))}
      </>}
    />
  );
}
