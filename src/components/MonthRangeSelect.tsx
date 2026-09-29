import { useEffect, useRef, useState } from "react";
import { type MonthOption } from "@/utils/monthRange";

interface Props {
  options: readonly MonthOption[];
  value: MonthOption;
  onChange: (months: MonthOption) => void;
  // What one step of the window is. The homepage's weekly grain reuses this
  // control as-is — same preset + custom + "all" shape — counting weeks.
  unit?: "months" | "weeks";
}

// Sibling of DayRangeSelect for the homepage's per-chart monthly mode. Same
// shape (preset select + custom number input + "all" sentinel) so the layout
// inside a chart card doesn't shift when you toggle granularity.
export function MonthRangeSelect({ options, value, onChange, unit = "months" }: Props) {
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

  // Debounce commits so spinner clicks / fast typing don't re-fetch on every
  // event. See DayRangeSelect for the closure-freshness rationale.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDebounce = () => {
    if (debounceRef.current != null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };
  useEffect(() => cancelDebounce, []);

  const perYear = unit === "weeks" ? 52 : 12;
  const short = unit === "weeks" ? "wk" : "mo";
  const labelFor = (opt: MonthOption): string => {
    if (opt === "all") return "All";
    if (opt >= perYear && opt % perYear === 0) return `${opt / perYear}y`;
    return `${opt} ${short}`;
  };

  const selectValue: string = isPreset ? String(value) : "custom";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: 'wrap' }}>
      <div>
      <span className="ctl-label">
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
        className="ctl"
      >
        {options.map((opt) => (
          <option key={String(opt)} value={String(opt)}>{labelFor(opt)}</option>
        ))}
        {!isPreset && <option value="custom">{value} {short}</option>}
      </select>
      </div>
      <input
        ref={inputRef}
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
        className="ctl"
        style={{ width: 52, cursor: "text" }}
        aria-label={`Time window (${unit})`}
      />
    </div>
  );
}
