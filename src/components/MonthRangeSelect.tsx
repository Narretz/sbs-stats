import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { type MonthOption } from "@/utils/monthRange";

interface Props {
  options: readonly MonthOption[];
  value: MonthOption;
  onChange: (months: MonthOption) => void;
}

// Sibling of DayRangeSelect for the homepage's per-chart monthly mode. Same
// shape (preset select + custom number input + "all" sentinel) so the layout
// inside a chart card doesn't shift when you toggle granularity.
export function MonthRangeSelect({ options, value, onChange }: Props) {
  const { theme: t } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value === "all" ? "" : String(value));

  useEffect(() => {
    const next = value === "all" ? "" : String(value);
    if (next !== draft) setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const isPreset = (options as readonly MonthOption[]).includes(value);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n !== value) {
      onChange(n);
    } else if (raw !== "") {
      setDraft(value === "all" ? "" : String(value));
    }
  };

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

  const labelFor = (opt: MonthOption): string => {
    if (opt === "all") return "All";
    if (opt >= 12 && opt % 12 === 0) return `${opt / 12}y`;
    return `${opt} mo`;
  };

  const selectValue: string = isPreset ? String(value) : "custom";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        Time Window
      </span>
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "all") onChange("all");
          else if (v === "custom") return;
          else onChange(Number(v));
        }}
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
        {options.map((opt) => (
          <option key={String(opt)} value={String(opt)}>{labelFor(opt)}</option>
        ))}
        {!isPreset && <option value="custom">{value} mo</option>}
      </select>
      <input
        ref={inputRef}
        type="number"
        min={1}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") inputRef.current?.blur();
        }}
        style={{
          background: t.bgAlt,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: 4,
          padding: "5px 6px",
          fontFamily: FONTS.mono,
          fontSize: 11,
          width: 52,
        }}
        aria-label="Time window (months)"
      />
    </div>
  );
}
