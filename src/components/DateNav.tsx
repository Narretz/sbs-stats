import { useTheme } from "@/hooks/useTheme";

interface Props {
  // Names the control and, through it, its buttons — two navs on the same page
  // (a window's start and its end) would otherwise both offer an unqualified
  // "Previous day". Also what the homepage uses to keep saying "Date", where
  // there is only one and "End" reads as half of a pair that isn't there.
  label: string;
  value: string;        // selected date ("" = none / live)
  min?: string;         // earliest selectable date, if the caller has a floor
  max: string;          // latest selectable date
  onChange: (date: string) => void;
  onShift: (delta: number) => void;
  canGoNext: boolean;
  canGoPrev?: boolean;  // default true — stepping back is usually unbounded
  // Whether to give the input the "active" treatment shared with pressed
  // toggles. Defaults to "a date is set", which is the right reading for an end
  // date that is otherwise live — but not for a derived start, which always has
  // one and would sit permanently lit.
  active?: boolean;
  title?: string;       // tooltip on the input, for a non-obvious control
  testId?: string;
}

// "‹ [date] ›" picker: step a day at a time or jump via the native date input.
// Shared by all daily & hourly views, by the homepage, and — through
// DayRangeSelect — by the window's start date, which is derived rather than
// stored but steps and jumps exactly like a real one.
export function DateNav({
  label, value, min, max, onChange, onShift, canGoNext, canGoPrev = true, active, title, testId,
}: Props) {
  const { theme: t } = useTheme();
  return (
    <div style={{display: "flex", alignItems: "center", gap: 6}}>
      <span className="ctl-label">
        {label}
      </span>
    <div style={{ display: "flex", gap: "3px" }}>
      <button className="ctl" onClick={() => onShift(-1)} disabled={!canGoPrev}
        aria-label={`${label}: previous day`}
        style={{ color: t.textMuted, height: 25 }}>&lt;</button>
      <input
        type="date"
        data-testid={testId}
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="ctl"
        // A set date is the "active" state, same treatment as a pressed toggle.
        aria-pressed={(active ?? !!value) ? true : undefined}
        aria-label={label}
        title={title}
        style={{ colorScheme: "dark" }}
      />
      <button className="ctl" onClick={() => onShift(1)} disabled={!canGoNext}
        aria-label={`${label}: next day`}
        style={{ color: t.textMuted, height: 25 }}>&gt;</button>
    </div>
    </div>
  );
}
