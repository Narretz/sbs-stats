import { useTheme } from "@/hooks/useTheme";

interface Props {
  value: string;        // selected date ("" = none / live)
  max: string;          // latest selectable date
  onChange: (date: string) => void;
  onShift: (delta: number) => void;
  canGoNext: boolean;
}

// "‹ [date] ›" picker: step a day at a time or jump via the native date input.
// Shared by all daily & hourly views.
export function DateNav({ value, max, onChange, onShift, canGoNext }: Props) {
  const { theme: t } = useTheme();
  return (
    <div style={{display: "flex", alignItems: "center", gap: 6}}>
      <span className="ctl-label">
        Date
      </span>
    <div style={{ display: "flex", gap: "3px" }}>
      <button className="ctl" onClick={() => onShift(-1)} aria-label="Previous day"
        style={{ color: t.textMuted, height: 25 }}>&lt;</button>
      <input
        type="date"
        value={value}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="ctl"
        // A set date is the "active" state, same treatment as a pressed toggle.
        aria-pressed={value ? true : undefined}
        style={{ colorScheme: "dark" }}
      />
      <button className="ctl" onClick={() => onShift(1)} disabled={!canGoNext} aria-label="Next day"
        style={{ color: t.textMuted, height: 25 }}>&gt;</button>
    </div>
    </div>
  );
}
