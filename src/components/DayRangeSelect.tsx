import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

interface Props<T extends number> {
  options: readonly T[];
  value: T;
  onChange: (days: T) => void;
}

// Time-window picker (e.g. 7d / 14d / 30d …) as a dropdown. Shared across the
// daily & hourly views, which pass their own option lists (generic over the
// page's DayOption union, so onChange matches each page's setter exactly).
export function DayRangeSelect<T extends number>({ options, value, onChange }: Props<T>) {
  const { theme: t } = useTheme();
  return (
    <div style={{display: "flex", alignItems: "center", gap: 6}}>
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        Time Window
      </span>
    <select
      data-testid="day-range"
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as T)}
      style={{
        background: t.bgAlt,
        color: t.text,
        border: `1px solid ${t.border}`,
        borderRadius: 4,
        padding: "5px 8px",
        fontFamily: FONTS.mono,
        fontSize: 11,
        cursor: "pointer",
      }}
    >
      {options.map((d) => (
        <option key={d} value={d}>{d}d</option>
      ))}
    </select>
  </div>
  );
}
