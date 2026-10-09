import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { MonthNav } from "@/components/MonthNav";
import type { MonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";

interface Props {
  yr: MonthlyMonthRange;
  min: string;  // the data's first month, YYYY-MM (a longer date is cut to its month)
  max?: string; // the live month; defaults to the current one (`yr.liveMonth`)
}

// A monthly page's window: its length and the month it ends at — the
// (end, length) pair the daily pages have as DayRangeSelect + DateNav.
export function MonthWindowControls({ yr, min, max = yr.liveMonth }: Props) {
  return (
    <>
      <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
      <MonthNav label="End" testId="month-end" value={yr.end} min={min.slice(0, 7)} max={max} onChange={yr.setEnd} />
    </>
  );
}
