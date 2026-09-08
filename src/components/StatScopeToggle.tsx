import { useStatScope, type StatScope } from "@/hooks/useStatScope";

// Global MAX/MED scope control. Rendered among the per-page chart controls (day
// range / weekday / date) because it shapes the same view, even though the
// preference itself is global (persisted, shared across all views).
//
// Callers must NOT render this when the page has no time-window control. On the
// monthly pages that's `yr.hidden` — the dataset is shorter than the smallest
// window preset, so the visible window IS the whole dataset. "Window data" and
// "All data" then compute over the same values and produce identical MAX / MED /
// TOTAL (maxMedian ignores the trailing nulls the axis is padded with), making
// the control a no-op that still invites a click.
export function StatScopeToggle() {
  const { scope, setScope } = useStatScope();

  const options: { value: StatScope; label: string }[] = [
    { value: 'all', label: 'All data' },
    { value: 'window', label: 'Window data' },
  ];

  return (
    <div
      title="MAX/MED reference lines: computed over all data, or just the visible window"
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <span className="ctl-label">
        MAX/MED/TOTAL Base
      </span>
      <select
        className="ctl"
        data-testid="stat-scope-select"
        value={scope}
        onChange={(e) => setScope(e.target.value as StatScope)}
      >
        {options.map((d) => (
          <option key={d.value} value={d.value}>{d.label}</option>
        ))}
      </select>
    </div>
  );
}
