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
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="ctl-label">
        Tooltip Sort
      </span>
      <select
        data-testid="tooltip-sort"
        value={value}
        onChange={(e) => onChange(e.target.value as TooltipSortMode)}
        className="ctl"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
