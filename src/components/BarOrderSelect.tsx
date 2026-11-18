import type { BarOrder } from "@/utils/barOrder";

const OPTIONS: { value: BarOrder; label: string }[] = [
  { value: "date", label: "Date" },
  { value: "max", label: "Highest first" },
  { value: "min", label: "Lowest first" },
];

// Bars in date order or ranked by value — see utils/barOrder.
export function BarOrderSelect({ value, onChange }: { value: BarOrder; onChange: (o: BarOrder) => void }) {
  return (
    <div
      title="Ranked: the window's length many past months up to its end, highest or lowest first"
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <span className="ctl-label">Order</span>
      <select
        className="ctl"
        data-testid="bar-order-select"
        value={value}
        onChange={(e) => onChange(e.target.value as BarOrder)}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
