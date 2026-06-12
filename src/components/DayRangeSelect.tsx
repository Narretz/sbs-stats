import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

interface Props<T extends number> {
  options: readonly T[];
  value: T;
  onChange: (days: T) => void;
}

// Time-window picker. Preset shortcuts in the select; an always-visible number
// input commits a custom value on Enter or blur. If `value` isn't a preset the
// select shows "Custom"; selecting "Custom" explicitly just focuses the input.
export function DayRangeSelect<T extends number>({ options, value, onChange }: Props<T>) {
  const { theme: t } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(value));

  // Keep the draft in sync when the active value changes from elsewhere (URL,
  // preset click). Avoid clobbering an in-progress edit by comparing parsed
  // numbers.
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const isPreset = (options as readonly number[]).includes(value);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n !== value) {
      onChange(n as T);
    } else {
      setDraft(String(value));
    }
  };

  // Listen for the DOM `change` event in addition to React's `onChange` (which
  // is actually the per-keystroke `input` event). The native `change` event
  // fires on spinner-button clicks, Enter, and blur-with-change — covering the
  // case where the user uses the number input's stepper without ever giving the
  // field keyboard focus (Firefox). Debounce so a flurry of spinner clicks
  // doesn't trigger a chart re-query on each step.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        commit(raw);
      }, 350);
    };
    el.addEventListener("change", handler);
    return () => {
      el.removeEventListener("change", handler);
      if (timer != null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const inputStyle = {
    background: t.bgAlt,
    color: t.text,
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    padding: "5px 6px",
    fontFamily: FONTS.mono,
    fontSize: 11,
    width: 52,
  } as const;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        Time Window
      </span>
      <select
        data-testid="day-range"
        value={isPreset ? String(value) : "custom"}
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
        {!isPreset && <option value="custom">{value}d</option>}
      </select>
      <input
        ref={inputRef}
        data-testid="day-range-custom"
        type="number"
        min={1}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") inputRef.current?.blur();
        }}
        style={inputStyle}
        aria-label="Time window (days)"
      />
    </div>
  );
}
