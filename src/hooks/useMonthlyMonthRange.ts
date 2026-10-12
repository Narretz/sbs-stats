import { useEffect, useMemo, useState } from "react";
import {
  MONTH_OPTIONS,
  clampEndMonth,
  DEFAULT_MONTHS,
  parseEndMonthParam,
  parseMonthsParam,
  sliceMonthWindow,
  type MonthOption,
} from "@/utils/monthRange";
import { resolvedEndMonth } from "@/utils/padTrailing";

// Shared state + URL sync for the monthly time-window picker. Pages call this
// hook to get the picker props plus a `slice` helper, and render
// <MonthRangeSelect> only when `hidden` is false (datasets with ≤12 months
// of data don't benefit from a 3m/6m/12m/… picker).
//
// This used to count years and shipped 1y/2y/3y presets; renamed and switched
// to months so the picker can offer 6m below 12m and accept a freeform month
// count in a custom-input alongside the presets — same shape as
// DayRangeSelect / MonthRangeSelect on the homepage.

function setParam(key: string, value: string) {
  const p = new URLSearchParams(window.location.search);
  if (value) p.set(key, value);
  else p.delete(key);
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

export interface MonthlyMonthRange {
  months: MonthOption;
  monthOptions: readonly MonthOption[];
  setMonths: (m: MonthOption) => void;
  /** True when the dataset is too short for the picker to be meaningful. */
  hidden: boolean;
  /** The window's last month, YYYY-MM ("" = live, the current month). */
  end: string;
  setEnd: (month: string) => void;
  /** The current month in the dataset's zone: where a live window ends. */
  liveMonth: string;
  /** The month the window ends at, resolved: `end`, or the current month. */
  endMonth: string;
  /** Keeps the last `months` rows up to `end`, or all of them up to it when
   *  "all" or the dataset is shorter than the window. */
  slice: <T>(rows: T[]) => T[];
}

/**
 * @param span - the dataset's full extent. `count` is its row count, used to
 *   decide whether to hide the picker (pass the un-sliced `allRows.length`);
 *   `first` its first month and `last` its live one (defaults to the current
 *   month), which bound `end` — see clampEndMonth.
 * @param defaultMonths - initial window when the URL carries no `months=`.
 *   Defaults to DEFAULT_MONTHS (12), which is right for the long-running
 *   sources. Short datasets that have only just crossed the 12-month
 *   picker threshold should pass "all": otherwise the moment they gain a
 *   13th month the page silently stops showing the 1st, which reads as data
 *   loss rather than as a window. Rubikon's two views do this.
 * @param tz - the zone whose current month is "live" (the dataset's own:
 *   Kyiv for most, Moscow for the RU-dated ones).
 */
export function useMonthlyMonthRange(
  span: { count: number; first: string; last?: string },
  defaultMonths: MonthOption = DEFAULT_MONTHS,
  tz = "Europe/Kyiv",
): MonthlyMonthRange {
  const monthOptions = useMemo(() => MONTH_OPTIONS, []);
  const [months, setMonthsState] = useState<MonthOption>(() =>
    parseMonthsParam(new URLSearchParams(window.location.search).get("months"), defaultMonths)
  );
  const [endState, setEndState] = useState<string>(() =>
    parseEndMonthParam(new URLSearchParams(window.location.search).get("end-month"))
  );
  const hidden = span.count <= 12;
  const liveMonth = resolvedEndMonth(tz);
  // Hidden with the range picker, so it goes with it too.
  const end = hidden ? "" : clampEndMonth(endState, span.first, span.last ?? liveMonth);
  // A clamped end (one outside this dataset, carried over from another site)
  // is written back, so the URL says what the picker shows. Replaced, not
  // pushed: the page we came from keeps its own end-month= in its history
  // entry. Not while hidden — that is also how a page looks before its data
  // has loaded, and the param must survive until it has.
  useEffect(() => {
    if (!hidden && end !== endState) {
      setEndState(end);
      setParam("end-month", end);
    }
  }, [hidden, end, endState]);
  // A clamped end (one outside this dataset, carried over from another site)
  // is written back, so the URL says what the picker shows. Replaced, not
  // pushed: the page we came from keeps its own end-month= in its history
  // entry. Not while hidden — that is also how a page looks before its data
  // has loaded, and the param must survive until it has.
  useEffect(() => {
    if (!hidden && end !== endState) {
      setEndState(end);
      setParam("end-month", end);
    }
  }, [hidden, end, endState]);
  const setMonths = (m: MonthOption) => {
    setMonthsState(m);
    setParam("months", String(m));
  };
  const setEnd = (month: string) => {
    setEndState(month);
    setParam("end-month", month);
  };
  const slice = <T,>(rows: T[]): T[] => sliceMonthWindow(rows, hidden ? "all" : months, end);
  return { months, monthOptions, setMonths, end, setEnd, liveMonth, endMonth: end || liveMonth, hidden, slice };
}

// Re-export the default so callers that need it don't have to reach into
// monthRange.ts directly.
export { DEFAULT_MONTHS };
