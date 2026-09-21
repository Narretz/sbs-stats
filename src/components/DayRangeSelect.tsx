import { useEffect, useRef, useState } from "react";
import { windowStartDate, daysBetweenInclusive } from "@/utils/dayRange";
import { DateNav } from "@/components/DateNav";

interface Props<T extends number> {
  options: readonly T[];
  value: T;
  onChange: (days: T) => void;
  // Supplying the window's end date turns on the start-date field. It is not a
  // second piece of state: a window is (end, length), and the start is the same
  // length spelled the other way round, so the field DISPLAYS
  // windowStartDate(endDate, value) and picking a date COMMITS the day count it
  // implies. Nothing to keep in sync, nothing to put in the URL, and no rule for
  // which of the two wins — there is only ever one window. Pages without an end
  // date to offer (the homepage's per-chart windows always end today) omit it
  // and get the picker as it was.
  endDate?: string;
  // Earliest date the dataset covers, used only as the field's `min`. Picking a
  // start years before the first row is harmless to the query but pads the
  // chart with thousands of empty days, so the browser stops it at the edge of
  // the data instead.
  minDate?: string;
}

// Time-window picker. Preset shortcuts in the select; an always-visible number
// input commits a custom value on Enter or blur. If `value` isn't a preset the
// select shows "Custom"; selecting "Custom" explicitly just focuses the input.
// With `endDate`, a start-date field is the third way to say the same thing —
// see the prop comment.
export function DayRangeSelect<T extends number>({ options, value, onChange, endDate, minDate }: Props<T>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(value));

  // Keep the draft in sync when the active value changes from elsewhere (URL,
  // preset click). Avoid clobbering an in-progress edit by comparing parsed
  // numbers.
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const isPreset = (options as readonly number[]).includes(value);

  const parse = (raw: string): number | null => {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
  };

  // Typing passes through states that aren't a value yet — the empty field you
  // get by clearing it, a lone "0" on the way to "05". So the debounce commits
  // when there is something to commit and otherwise waits: putting the old
  // value back mid-edit took the field away from under the cursor the instant
  // it was cleared.
  const commitIfValid = (raw: string) => {
    const n = parse(raw);
    if (n != null && n !== value) onChange(n as T);
  };

  // Blur is what ends an edit, so it is what decides an unfinished one is
  // over: commit a value, put the old one back for anything else.
  const commitOrRevert = (raw: string) => {
    const n = parse(raw);
    if (n == null) setDraft(String(value));
    else if (n !== value) onChange(n as T);
    else setDraft(String(n));
  };

  // Debounce commits so a flurry of spinner-button clicks (or fast typing)
  // doesn't re-fetch the chart on every keystroke. The timer is scheduled
  // inside React's onChange, so its closure captures the props from the
  // render that just produced this handler — fresh per gesture. (An older
  // version of this component bound a native `change` listener inside a
  // useEffect with stale deps; that one captured props from a past render
  // and clobbered any state change the parent made in the meantime.)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDebounce = () => {
    if (debounceRef.current != null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };
  useEffect(() => cancelDebounce, []);

  const inputStyle = { width: 52, cursor: "text" } as const;

  // No draft state for the start field, unlike the number input above: a native
  // date input reports "" until the date is complete, so there are no
  // half-typed values to protect, and the control being fully derived means an
  // ignored edit snaps back to the real window on the next render for free.
  const hasFloor = !!minDate && /^\d{4}-\d{2}-\d{2}$/.test(minDate);
  const startDate = endDate ? windowStartDate(endDate, value) : "";
  const commitStart = (raw: string) => {
    if (!endDate) return;
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
  const canStartGoPrev = !hasFloor || !endDate || windowStartDate(endDate, value + 1) >= minDate!;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {endDate && (
        <DateNav
          label="Start"
          testId="window-start"
          value={startDate}
          min={hasFloor ? minDate : undefined}
          max={endDate}
          onChange={commitStart}
          onShift={shiftStart}
          canGoPrev={canStartGoPrev}
          canGoNext={canStartGoNext}
          active={false}
          title="First day of the window — moving it sets the time window to match"
        />
      )}
      <span className="ctl-label">
        Time Window
      </span>
      <select
        data-testid="day-range"
        value={isPreset ? String(value) : "custom"}
        onChange={(e) => onChange(Number(e.target.value) as T)}
        className="ctl"
      >
        {options.map((d) => (
          <option key={d} value={d}>{d}d</option>
        ))}
        {!isPreset && <option value="custom">{value}d</option>}
      </select>
      <input
        ref={inputRef}
        data-testid="day-range-custom"
        type="number"
        min={1}
        step={1}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          cancelDebounce();
          debounceRef.current = setTimeout(() => commitIfValid(v), 350);
        }}
        onBlur={(e) => {
          cancelDebounce();
          commitOrRevert(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") inputRef.current?.blur();
        }}
        className="ctl"
        style={inputStyle}
        aria-label="Time window (days)"
      />
    </div>
  );
}
