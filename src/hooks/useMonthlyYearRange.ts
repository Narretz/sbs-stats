import { useMemo, useState } from "react";
import { DEFAULT_YEAR_OPTION, getYearOptions, type YearOption } from "@/utils/yearRange";

// Shared state + URL sync for the monthly time-window picker. Mirrors the
// pattern previously inlined in RuAirAttacksMonthlyPage; pages now call this
// hook to get the picker props plus a `slice` helper, and render
// <YearRangeSelect> only when `hidden` is false (datasets with ≤12 months
// of data don't benefit from a 1y/2y/… picker).

function parseYearsParam(raw: string | null, allowed: readonly YearOption[]): YearOption {
  const n = Number(raw);
  return (allowed as readonly number[]).includes(n) ? (n as YearOption) : DEFAULT_YEAR_OPTION;
}

function setYearsParam(years: YearOption) {
  const p = new URLSearchParams(window.location.search);
  p.set("years", String(years));
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

export interface MonthlyYearRange {
  years: YearOption;
  yearOptions: readonly YearOption[];
  setYears: (y: YearOption) => void;
  /** True when the dataset is too short for the picker to be meaningful. */
  hidden: boolean;
  /** Trailing-slice helper: keeps the last `years * 12` rows (or all if shorter). */
  slice: <T>(rows: T[]) => T[];
}

/**
 * @param totalMonths - the dataset's full row count, used to decide whether to
 *   hide the picker. Pass the un-sliced `allRows.length`.
 */
export function useMonthlyYearRange(totalMonths: number): MonthlyYearRange {
  const yearOptions = useMemo(() => getYearOptions(), []);
  const [years, setYearsState] = useState<YearOption>(() =>
    parseYearsParam(new URLSearchParams(window.location.search).get("years"), yearOptions)
  );
  const setYears = (y: YearOption) => {
    setYearsState(y);
    setYearsParam(y);
  };
  const hidden = totalMonths <= 12;
  const slice = <T,>(rows: T[]): T[] => {
    if (hidden) return rows;
    const want = years * 12;
    return rows.length > want ? rows.slice(rows.length - want) : rows;
  };
  return { years, yearOptions, setYears, hidden, slice };
}
