import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import type { YearOption } from "@/utils/yearRange";

interface Props {
  options: readonly YearOption[];
  value: YearOption;
  onChange: (years: YearOption) => void;
}

// Time-window picker for monthly charts (1y / 2y / 3y …). Mirrors
// DayRangeSelect; option list is built dynamically from the war start date by
// `getYearOptions`, so the picker grows as the war drags on.
export function YearRangeSelect({ options, value, onChange }: Props) {
  const { theme: t } = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        Time Window
      </span>
      <select
        data-testid="year-range"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as YearOption)}
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
        {options.map((y) => (
          <option key={y} value={y}>{y}y</option>
        ))}
      </select>
    </div>
  );
}
