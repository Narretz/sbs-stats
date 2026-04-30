import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface WeekdayMultiSelectProps {
  selected: number[];
  onChange: (next: number[]) => void;
  todayDow: number;
}

export function WeekdayMultiSelect({ selected, onChange, todayDow }: WeekdayMultiSelectProps) {
  const { theme: t } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const active = selected.length > 0;
  const summary = !active
    ? "All weekdays"
    : selected.length === 7
      ? "All weekdays"
      : selected.map(d => DOW_LABELS[d]).join(", ");

  const toggle = (dow: number) => {
    const next = selected.includes(dow)
      ? selected.filter(d => d !== dow)
      : [...selected, dow].sort((a, b) => a - b);
    onChange(next);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: active ? t.accent : t.bgAlt,
          color: active ? "#fff" : t.textMuted,
          border: `1px solid ${active ? t.accent : t.border}`,
          borderRadius: 4, padding: "5px 12px",
          fontFamily: FONTS.mono, fontSize: 11,
          fontWeight: active ? 700 : 400,
          cursor: "pointer", transition: "all 0.15s",
          display: "inline-flex", alignItems: "center", gap: 6,
        }}
      >
        <span>Weekdays: {summary}</span>
        <span style={{ fontSize: 8, opacity: 0.7 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
          background: t.bgAlt, border: `1px solid ${t.border}`,
          borderRadius: 4, padding: 6, minWidth: 140,
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
          fontFamily: FONTS.mono, fontSize: 11,
        }}>
          {DOW_LABELS.map((lab, dow) => {
            const checked = selected.includes(dow);
            return (
              <label key={dow} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "4px 6px", cursor: "pointer", borderRadius: 3,
                color: checked ? t.text : t.textMuted,
                fontWeight: checked ? 700 : 400,
              }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(dow)}
                  style={{ cursor: "pointer", accentColor: t.accent }}
                />
                <span>{lab}{dow === todayDow ? " (today)" : ""}</span>
              </label>
            );
          })}
          {active && (
            <button
              onClick={() => onChange([])}
              style={{
                marginTop: 4, width: "100%",
                background: "transparent", color: t.textMuted,
                border: `1px solid ${t.border}`, borderRadius: 3,
                padding: "4px 8px", fontFamily: FONTS.mono, fontSize: 10,
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
