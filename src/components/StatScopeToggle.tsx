import { useTheme } from "@/hooks/useTheme";
import { useStatScope, type StatScope } from "@/hooks/useStatScope";
import { FONTS } from "@/theme";

// Global MAX/MED scope control. Rendered among the per-page chart controls (day
// range / weekday / date) because it shapes the same view, even though the
// preference itself is global (persisted, shared across all views).
export function StatScopeToggle() {
  const { theme: t } = useTheme();
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
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        MAX/MED/TOTAL Base
      </span>
      <select
        data-testid="stat-scope-select"
        value={scope}
        onChange={(e) => setScope(e.target.value as StatScope)}
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
          <option key={d.value} value={d.value}>{d.label}</option>
        ))}
      </select>
    </div>
  );
}
