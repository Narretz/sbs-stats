import { windowStartDate, daysBetweenInclusive, maxDaysFor } from "@/utils/dayRange";
import { DateNav } from "@/components/DateNav";

interface Props<T extends number> {
  // The window's length — the one piece of state. See below.
  value: T;
  onChange: (days: T) => void;
  // The window's end date. The start is measured back from it.
  endDate: string;
  // Earliest date the dataset covers. Tightens the field's floor past
  // WINDOW_FLOOR where a dataset begins later than the war did — picking a
  // start before the first row is harmless to the query but pads the chart with
  // empty days, so the browser stops it at the edge of the data instead.
  minDate?: string;
}

// The window's start date. Not a second piece of state: a window is (end,
// length), and the start is the same length spelled the other way round, so
// the field DISPLAYS windowStartDate(endDate, value) and picking a date COMMITS
// the day count it implies. Nothing to keep in sync, nothing to put in the URL,
// and no rule for which of the two wins — there is only ever one window. It is
// its own control rather than part of DayRangeSelect so a page can tuck it
// away (behind MoreControls) while keeping the length in view.
//
// No draft state, unlike DayRangeSelect's number input: a native date input
// reports "" until the date is complete, so there are no half-typed values to
// protect, and the control being fully derived means an ignored edit snaps
// back to the real window on the next render for free.
export function WindowStartNav<T extends number>({ value, onChange, endDate, minDate }: Props<T>) {
  const hasFloor = !!minDate && /^\d{4}-\d{2}-\d{2}$/.test(minDate);
  // The earliest start on offer: as far back as the floor allows, or the first
  // day of the data when that is later. windowStartDate of the widest window is
  // WINDOW_FLOOR itself, and can never land after the end it was measured from,
  // so the input's min <= max holds even for an end date before the war.
  const hardStart = windowStartDate(endDate, maxDaysFor(endDate));
  const startMin = hasFloor && minDate! > hardStart && minDate! <= endDate ? minDate! : hardStart;
  const startDate = windowStartDate(endDate, value);
  const commitStart = (raw: string) => {
    const d = daysBetweenInclusive(raw, endDate);
    if (d != null && d !== value) onChange(d as T);
  };
  // Stepping the start is the window growing or shrinking from its left edge —
  // the end stays put, so a day later is a day shorter. (The end-date nav next
  // to it reads the opposite way: there the length is what stays put.)
  const shiftStart = (delta: number) => {
    const next = value - delta;
    if (next >= 1) onChange(next as T);
  };
  // A day later must leave at least the end date itself; a day earlier must
  // stay inside the data, when the caller said where that ends.
  const canStartGoNext = value > 1;
  const canStartGoPrev = windowStartDate(endDate, value + 1) >= startMin;

  return (
    <DateNav
      label="Start"
      testId="window-start"
      value={startDate}
      min={startMin}
      max={endDate}
      onChange={commitStart}
      onShift={shiftStart}
      canGoPrev={canStartGoPrev}
      canGoNext={canStartGoNext}
      active={false}
      liveAtMax={false}
      title="First day of the window — moving it sets the time window to match"
    />
  );
}
