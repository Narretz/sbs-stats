import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

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
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        Date
      </span>
    <div style={{ display: "flex", gap: "3px" }}>
      <button onClick={() => onShift(-1)} style={{
        background: t.bgAlt, color: t.textMuted,
        border: `1px solid ${t.border}`,
        fontFamily: FONTS.mono, fontSize: 11,
        borderRadius: 4, padding: "5px 8px", height: "25px", cursor: "pointer",
      }}>&lt;</button>
      <input
        type="date"
        value={value}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: value ? t.primary : t.bgAlt,
          color: value ? "#fff" : t.textMuted,
          border: `1px solid ${value ? t.primary : t.border}`,
          borderRadius: 4, padding: "5px 8px",
          fontFamily: FONTS.mono, fontSize: 11,
          cursor: "pointer", transition: "all 0.15s",
          colorScheme: "dark",
        }}
      />
      <button onClick={() => onShift(1)} disabled={!canGoNext} style={{
        background: t.bgAlt, color: canGoNext ? t.textMuted : t.border,
        border: `1px solid ${t.border}`,
        fontFamily: FONTS.mono, fontSize: 11,
        borderRadius: 4, padding: "5px 8px", height: "25px",
        cursor: canGoNext ? "pointer" : "not-allowed",
      }}>&gt;</button>
    </div>
    </div>
  );
}
