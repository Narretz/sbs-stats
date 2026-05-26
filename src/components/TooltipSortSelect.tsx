import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import type { TooltipSortMode } from "@/components/HourlyLineChart";

interface Props {
  value: TooltipSortMode;
  onChange: (mode: TooltipSortMode) => void;
}

const OPTIONS: { value: TooltipSortMode; label: string }[] = [
  { value: "value", label: "Value" },
  { value: "date", label: "Date" },
];

// Sort order for the per-day rows in the hourly charts' shared hover tooltip.
// Used by the hourly views (SBS + GSUA).
export function TooltipSortSelect({ value, onChange }: Props) {
  const { theme: t } = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        Tooltip Sort
      </span>
      <select
        data-testid="tooltip-sort"
        value={value}
        onChange={(e) => onChange(e.target.value as TooltipSortMode)}
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
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
