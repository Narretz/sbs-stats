import { useMemo } from "react";
import { Temporal } from "temporal-polyfill";
import { useTheme } from "@/hooks/useTheme";
import { monthsOfYear, switchYear, yearsBetween } from "@/utils/monthRange";

interface Props {
  label: string;
  value: string;   // selected month, YYYY-MM ("" = live)
  min: string;     // earliest selectable month, YYYY-MM
  max: string;     // latest selectable month — the current one, which is "live"
  onChange: (month: string) => void;
  testId?: string; // the year select gets `${testId}-year`, the month select `${testId}-month`
}

// "‹ [year ▾] [month ▾] ›": DateNav's shape for a month. Not
// `<input type="month">`, which desktop Firefox and Safari render as a plain
// text box. Two selects rather than one list of every month: a year back is
// one pick instead of a scroll through dozens.
//
// Live is no separate option. Like DateNav's end date, reaching `max` — the
// latest year and its latest month, labelled "(live)" — means live (""). No
// "pressed" fill for a set month either: on a select, Firefox paints it onto
// every option in the open list.
export function MonthNav({ label, value, min, max, onChange, testId }: Props) {
  const { theme: t } = useTheme();
  const lo = min && min <= max ? min : max;
  const current = value || max;
  const year = current.slice(0, 4);
  const years = useMemo(() => yearsBetween(lo, max), [lo, max]);
  const months = useMemo(() => monthsOfYear(year, lo, max), [year, lo, max]);

  const pick = (month: string) => onChange(month >= max ? "" : month);
  const step = (delta: number) =>
    pick(Temporal.PlainYearMonth.from(current).add({ months: delta }).toString());

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="ctl-label">{label}</span>
      <div style={{ display: "flex", gap: "3px" }}>
        <button className="ctl" onClick={() => step(-1)} disabled={current <= lo}
          aria-label={`${label}: previous month`}
          style={{ color: t.textMuted, height: 25 }}>&lt;</button>
        <select
          className="ctl"
          data-testid={testId && `${testId}-year`}
          aria-label={`${label} year`}
          value={year}
          onChange={(e) => pick(switchYear(current, e.target.value, lo, max))}
        >
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select
          className="ctl"
          data-testid={testId && `${testId}-month`}
          aria-label={`${label} month`}
          value={current}
          onChange={(e) => pick(e.target.value)}
          style={{ textTransform: "none" }}
        >
          {months.map((m) => (
            <option key={m} value={m}>{monthName(m)}{m === max ? " (live)" : ""}</option>
          ))}
        </select>
        <button className="ctl" onClick={() => step(1)} disabled={current >= max}
          aria-label={`${label}: next month`}
          style={{ color: t.textMuted, height: 25 }}>&gt;</button>
      </div>
    </div>
  );
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthName(month: string): string {
  return MONTH_NAMES[Number(month.slice(5, 7)) - 1];
}
