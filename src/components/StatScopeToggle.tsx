import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { FONTS } from "@/theme";

// Global MAX/MED scope control. Rendered among the per-page chart controls (day
// range / weekday / date) because it shapes the same view, even though the
// preference itself is global (persisted, shared across all views).
export function StatScopeToggle() {
  const { theme: t } = useTheme();
  const { scope, setScope } = useStatScope();
  return (
    <div
      title="MAX/MED reference lines: computed over all data, or just the visible window"
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        MAX/MED
      </span>
      <div style={{ display: "flex", border: `1px solid ${t.border}`, borderRadius: 4, overflow: "hidden" }}>
        {(["all", "window"] as const).map((s) => (
          <button
            key={s}
            data-testid={`statscope-${s}`}
            onClick={() => setScope(s)}
            style={{
              background: scope === s ? t.primary : t.bgAlt,
              color: scope === s ? "#ffffff" : t.textMuted,
              border: "none",
              padding: "5px 10px",
              fontFamily: FONTS.mono,
              fontSize: 11,
              fontWeight: scope === s ? 700 : 400,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {s === "all" ? "All" : "Window"}
          </button>
        ))}
      </div>
    </div>
  );
}
