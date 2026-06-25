import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import {
  COMBINED_METRICS,
  SOURCE_LABELS,
  type CombinedMetric,
  type MetricSource,
  type MetricView,
} from "@/utils/combinedMetrics";

interface Props {
  selected: string[];
  onChange: (next: string[]) => void;
  view: MetricView;
}

const SOURCE_ORDER: MetricSource[] = [
  "sbs",
  "gsua",
  "ru-losses",
  "ru-airdef-mod",
  "ru-air-attacks",
  "sbu-alfa",
  "mediazona-roles",
  "mediazona-estimate",
];

// Minimal local types — React 18's JSX types don't include the popover
// attributes yet. We pass them through as data on the element and rely on the
// browser to wire up popover behavior. Names must be lowercase: React 18 logs
// a "does not recognize the prop" warning for unknown camelCase props on DOM
// elements but passes lowercase ones through as plain HTML attributes.
type PopoverProps = {
  popover?: "auto" | "manual";
  popovertarget?: string;
  popovertargetaction?: "show" | "hide" | "toggle";
};

export function MetricPicker({ selected, onChange, view }: Props) {
  const { theme: t } = useTheme();
  // Per-instance ID — useId() guarantees uniqueness when multiple pickers
  // render on the same page (one per chart on the homepage).
  const reactId = useId();
  const popoverId = `metric-picker-${reactId.replace(/:/g, "-")}`;
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Position the popover relative to the trigger button when it opens.
  // Popovers default to the top layer at fixed 0,0, so we own placement
  // ourselves — anchor positioning would be cleaner but is still patchy
  // across browsers in 2026.
  //
  // Flip above the trigger when the chart is near the bottom of the viewport
  // and there's more room above than below; cap max-height to whatever space
  // is actually available so the picker never gets clipped off-screen.
  useEffect(() => {
    const pop = popoverRef.current;
    if (!pop) return;
    const handleToggle = (e: Event) => {
      const ev = e as ToggleEvent;
      if (ev.newState !== "open") return;
      const btn = triggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const popWidth = 360;
      const popHeightPref = 480;
      const margin = 8;
      const gap = 4;
      // Horizontal: right-align to the trigger, clamped to viewport edges.
      let left = rect.right - popWidth;
      if (left < margin) left = margin;
      const maxLeft = window.innerWidth - popWidth - margin;
      if (left > maxLeft) left = maxLeft;
      // Vertical: prefer below; flip above when below is too cramped and
      // above has more room. Always cap maxHeight to the available space.
      const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const placeAbove = spaceBelow < Math.min(popHeightPref, 280) && spaceAbove > spaceBelow;
      const available = placeAbove ? spaceAbove : spaceBelow;
      const height = Math.max(160, Math.min(popHeightPref, available));
      const top = placeAbove
        ? Math.max(margin, rect.top - gap - height)
        : Math.round(rect.bottom + gap);
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
      pop.style.maxHeight = `${Math.round(height)}px`;
      // Light-dismiss focus behavior: focus the search input on open.
      setTimeout(() => searchRef.current?.focus(), 0);
    };
    pop.addEventListener("toggle", handleToggle as EventListener);
    return () => pop.removeEventListener("toggle", handleToggle as EventListener);
  }, []);

  const available = useMemo(
    () => COMBINED_METRICS.filter((m) => m.views.includes(view)),
    [view]
  );

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return available;
    // Token-AND match: every whitespace-separated token must appear somewhere
    // in the haystack. Means "sbs person" matches "SBS · Personnel Killed".
    return available.filter((m) => {
      const haystack = `${m.label} ${m.source} ${m.key}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });
  }, [available, query]);

  const grouped = useMemo(() => {
    const map = new Map<MetricSource, CombinedMetric[]>();
    for (const m of filtered) {
      if (!map.has(m.source)) map.set(m.source, []);
      map.get(m.source)!.push(m);
    }
    return SOURCE_ORDER.flatMap((s) => {
      const list = map.get(s);
      return list ? [{ source: s, metrics: list }] : [];
    });
  }, [filtered]);

  const selectedSet = new Set(selected);
  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  const triggerProps: PopoverProps = { popovertarget: popoverId };
  const popoverProps: PopoverProps = { popover: "auto" };
  const closeProps: PopoverProps = { popovertarget: popoverId, popovertargetaction: "hide" };

  const btnStyle = {
    background: t.bgAlt,
    color: t.text,
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    padding: "5px 10px",
    fontFamily: FONTS.mono,
    fontSize: 11,
    cursor: "pointer",
  } as const;

  return (
    <>
      <button
        ref={triggerRef}
        {...triggerProps}
        style={{
          background: t.bgAlt,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: 4,
          padding: "5px 10px",
          fontFamily: FONTS.mono,
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        {selected.length === 0 ? "+ add metric" : `${selected.length} metric${selected.length === 1 ? "" : "s"} ▾`}
      </button>
      <div
        ref={popoverRef}
        id={popoverId}
        {...popoverProps}
        style={{
          // The popover API places this in the top layer; we just provide our
          // own placement and chrome. Reset the UA defaults that come with the
          // attribute (margin/inset/border/padding) so our positioning sticks.
          position: "fixed",
          inset: "unset",
          margin: 0,
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 6,
          padding: 8,
          width: 360,
          // maxHeight is set dynamically on open so the picker is never
          // clipped by the viewport edge — see the toggle effect above.
          overflowY: "auto",
          boxShadow: "0 4px 20px rgba(0,0,0,0.22)",
          color: t.text,
        }}
      >
        <input
          ref={searchRef}
          placeholder="Search metrics…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: t.bgAlt,
            color: t.text,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            padding: "5px 8px",
            fontFamily: FONTS.mono,
            fontSize: 11,
            marginBottom: 8,
          }}
        />
        <div style={{ display: "flex", gap: 6, justifyContent: 'space-between', marginBottom: 8 }}>
          <button
            onClick={() => onChange([])}
            disabled={selected.length === 0}
            style={{ ...btnStyle, fontSize: 10, opacity: selected.length === 0 ? 0.45 : 1 }}
          >
            Clear all
          </button>
          <button {...closeProps} style={{...btnStyle, fontSize: 10}}>
            Close
          </button>
        </div>
        {grouped.length === 0 && (
          <div style={{ color: t.textMuted, fontFamily: FONTS.mono, fontSize: 11, padding: 6 }}>
            No matches.
          </div>
        )}
        {grouped.map(({ source, metrics }) => (
          <div key={source} style={{ marginBottom: 8 }}>
            <div
              style={{
                fontFamily: FONTS.display,
                fontSize: 10,
                fontWeight: 700,
                color: t.textMuted,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                padding: "4px 4px 2px",
              }}
            >
              {SOURCE_LABELS[source]}
            </div>
            {metrics.map((m) => {
              const on = selectedSet.has(m.id);
              return (
                <label
                  key={m.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 6px",
                    fontFamily: FONTS.mono,
                    fontSize: 11,
                    cursor: "pointer",
                    borderRadius: 3,
                    color: on ? t.text : t.textMuted,
                    background: on ? t.bgAlt : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(m.id)}
                    style={{ cursor: "pointer" }}
                  />
                  <span>{m.metricLabel}</span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
