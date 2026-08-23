import { useEffect, useMemo, useState } from "react";
import type { LoadState, Stat } from "@/types";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { maxMedian } from "@/utils/windowStats";

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
  loadState, queryMonthly, refreshKey, keys,
}: {
  loadState: LoadState;
  queryMonthly: () => Row[];
  refreshKey?: number;
  keys?: readonly K[];
}): {
  allRows: Row[];
  rows: Row[];
  hasData: boolean;
  yr: ReturnType<typeof useMonthlyMonthRange>;
  allStats: Record<K, Stat>;
} {
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setAllRows(queryMonthly());
      setHasData(true);
    }
  }, [loadState, queryMonthly, refreshKey]);

  const yr = useMonthlyMonthRange(allRows.length);
  const rows = useMemo(() => yr.slice(allRows), [allRows, yr]);

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

  return { allRows, rows, hasData, yr, allStats };
}
