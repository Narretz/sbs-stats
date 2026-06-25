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

  // Debounce commits so a flurry of spinner-button clicks (or fast typing)
  // doesn't re-fetch the chart on every keystroke. The timer is scheduled
  // inside React's onChange, so its closure captures the props from the
  // render that just produced this handler — fresh per gesture. (An older
  // version of this component bound a native `change` listener inside a
  // useEffect with stale deps; that one captured props from a past render
  // and clobbered any state change the parent made in the meantime.)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDebounce = () => {
    if (debounceRef.current != null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };
  useEffect(() => cancelDebounce, []);

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
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          cancelDebounce();
          debounceRef.current = setTimeout(() => commit(v), 350);
        }}
        onBlur={(e) => {
          cancelDebounce();
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") inputRef.current?.blur();
        }}
        style={inputStyle}
        aria-label="Time window (days)"
      />
    </div>
  );
}
