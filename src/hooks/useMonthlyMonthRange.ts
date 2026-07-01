import { useMemo, useState } from "react";
import {
  MONTH_OPTIONS,
  DEFAULT_MONTHS,
  parseMonthsParam,
  type MonthOption,
} from "@/utils/monthRange";

// Shared state + URL sync for the monthly time-window picker. Pages call this
// hook to get the picker props plus a `slice` helper, and render
// <MonthRangeSelect> only when `hidden` is false (datasets with ≤12 months
// of data don't benefit from a 3m/6m/12m/… picker).
//
// This used to count years and shipped 1y/2y/3y presets; renamed and switched
// to months so the picker can offer 6m below 12m and accept a freeform month
// count in a custom-input alongside the presets — same shape as
// DayRangeSelect / MonthRangeSelect on the homepage.

function setMonthsParam(months: MonthOption) {
  const p = new URLSearchParams(window.location.search);
  p.set("months", String(months));
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

export interface MonthlyMonthRange {
  months: MonthOption;
  monthOptions: readonly MonthOption[];
  setMonths: (m: MonthOption) => void;
  /** True when the dataset is too short for the picker to be meaningful. */
  hidden: boolean;
  /** Trailing-slice helper: keeps the last `months` rows, or all when "all"
   *  or the dataset is shorter than the window. */
  slice: <T>(rows: T[]) => T[];
}

/**
 * @param totalMonths - the dataset's full row count, used to decide whether to
 *   hide the picker. Pass the un-sliced `allRows.length`.
 */
export function useMonthlyMonthRange(totalMonths: number): MonthlyMonthRange {
  const monthOptions = useMemo(() => MONTH_OPTIONS, []);
  const [months, setMonthsState] = useState<MonthOption>(() =>
    parseMonthsParam(new URLSearchParams(window.location.search).get("months"))
  );
  const setMonths = (m: MonthOption) => {
    setMonthsState(m);
    setMonthsParam(m);
  };
  const hidden = totalMonths <= 12;
  const slice = <T,>(rows: T[]): T[] => {
    if (hidden || months === "all") return rows;
    return rows.length > months ? rows.slice(rows.length - months) : rows;
  };
  return { months, monthOptions, setMonths, hidden, slice };
}

// Re-export the default so callers that need it don't have to reach into
// monthRange.ts directly.
export { DEFAULT_MONTHS };
