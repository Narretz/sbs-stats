import { useEffect, useMemo, useState } from "react";
import type { LoadState, Stat } from "@/types";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { maxMedian } from "@/utils/windowStats";
import { rankingOf, type BarOrder, type Ranking } from "@/utils/barOrder";
import { afterPaint } from "@/utils/afterPaint";

// Shared monthly-page data plumbing. Nearly every monthly dataset page repeats
// the same steps: load all rows once the DB is ready, expose a `hasData` flag,
// drive the year-range picker off the row count, slice the rows to the picked
// range, and compute whole-dataset {max, median, total} per metric off the
// UN-sliced rows (so the "all" stat scope reflects the full history, not just
// the window). This hook owns exactly that.
//
// `keys` is optional: pass a metric-key list to get the standard `allStats`;
// omit it (e.g. SBS, which derives stats over dynamically-discovered columns)
// and compute stats yourself off the returned `allRows`. Pass a STABLE `keys`
// reference (a module-level const) so `allStats` doesn't recompute each render.
//
export function useMonthlyMetricGrid<Row extends { date: string }, K extends string = never>({
  loadState, queryMonthly, refreshKey, keys, tz, order = "date",
}: {
  loadState: LoadState;
  queryMonthly: () => Row[];
  refreshKey?: number;
  keys?: readonly K[];
  tz?: string; // see useMonthlyMonthRange
  /** Ranked (utils/barOrder), `rows` is every month up to the window's end
   *  and `ranking` keeps as many as the window has. */
  order?: BarOrder;
}): {
  allRows: Row[];
  rows: Row[];
  hasData: boolean;
  yr: ReturnType<typeof useMonthlyMonthRange>;
  allStats: Record<K, Stat>;
  ranking: Ranking | null;
} {
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [hasData, setHasData] = useState(false);

  // After a paint (utils/afterPaint): a slow source's query would otherwise
  // freeze the page before its loading message is drawn.
  useEffect(() => {
    if (loadState !== "ready") return;
    return afterPaint(() => {
      setAllRows(queryMonthly());
      setHasData(true);
    });
  }, [loadState, queryMonthly, refreshKey]);

  const yr = useMonthlyMonthRange({ count: allRows.length, first: allRows[0]?.date ?? "" }, undefined, tz);
  const rows = useMemo(() => yr.view(allRows, order), [allRows, yr, order]);
  const ranking = rankingOf(order, yr.slice(allRows).length);

  const allStats = useMemo(() => {
    const out = {} as Record<K, Stat>;
    for (const k of keys ?? []) {
      out[k] = maxMedian(
        allRows.map((r) => {
          const v = (r as Record<string, unknown>)[k];
          return typeof v === "number" ? v : null;
        }),
      );
    }
    return out;
  }, [allRows, keys]);

  return { allRows, rows, hasData, yr, allStats, ranking };
}
