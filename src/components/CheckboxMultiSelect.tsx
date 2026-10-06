import { useEffect, useId, useRef } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { clampLeft, placePopover } from "@/components/popoverPlacement";

// A labelled "pick several" control: a `.ctl` button that opens a checkbox
// list. Not a <select multiple>: on desktop that renders as an always-open
// list box picked with Ctrl/Cmd-click, which few readers know.
//
// The list is a native popover (top layer), like MetricPicker's: it can't be
// clipped or covered by the sticky controls bar it is opened from, and closes
// on a click outside or Esc without any handler of ours.
//
// Nothing ticked means "all" (`allLabel`) — the same reading the weekday
// filter gives an empty selection.

// React 18's JSX types don't include the popover attributes; lowercase names
// pass through as plain HTML attributes. See MetricPicker.
type PopoverProps = {
  popover?: "auto" | "manual";
  popovertarget?: string;
  popovertargetaction?: "show" | "hide" | "toggle";
};

export interface MultiSelectOption {
  value: string;
  label: string;
  color?: string; // a swatch beside the label, e.g. the series colour it draws in
}

interface Props {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  testId?: string;
  // What the button says for a selection, when the default (up to two names,
  // then "N selected") doesn't fit — the weekday filter names every day.
  summarize?: (selected: string[]) => string;
  // Give the button the pressed (filled) treatment, for a selection that is a
  // filter worth seeing at a glance.
  active?: boolean;
}

const POP_HEIGHT_PREF = 420;
const POP_MAX_WIDTH = 320;

export function CheckboxMultiSelect({ label, options, selected, onChange, allLabel, testId, summarize, active }: Props) {
  const { theme: t } = useTheme();
  const popoverId = `multi-select-${useId().replace(/:/g, "-")}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Placed before it opens (see popoverPlacement.ts), left-aligned to the
  // trigger. It is as wide as its longest option, which can't be measured
  // until it is shown, so it is placed against its maximum width and its left
  // edge re-clamped once open — which only moves it at the viewport's edge.
  useEffect(() => {
    const pop = popoverRef.current;
    if (!pop) return;
    const handleBeforeToggle = (e: Event) => {
      if ((e as ToggleEvent).newState !== "open" || !triggerRef.current) return;
      placePopover(pop, triggerRef.current, {
        width: POP_MAX_WIDTH, prefHeight: POP_HEIGHT_PREF, minHeight: 140, flipBelow: 240, align: "left",
      });
    };
    const handleToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === "open") clampLeft(pop);
    };
    pop.addEventListener("beforetoggle", handleBeforeToggle);
    pop.addEventListener("toggle", handleToggle);
    return () => {
      pop.removeEventListener("beforetoggle", handleBeforeToggle);
      pop.removeEventListener("toggle", handleToggle);
    };
  }, []);

  const selectedSet = new Set(selected);
  // Kept in the options' order, not the order they were ticked in, so the
  // same selection always reads (and serialises) the same way.
  const toggle = (value: string) => {
    const next = selectedSet.has(value)
      ? selected.filter((v) => v !== value)
      : options.map((o) => o.value).filter((v) => v === value || selectedSet.has(v));
    onChange(next);
  };

  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const summary =
    selected.length === 0 ? allLabel
    : summarize ? summarize(selected)
    : selected.length <= 2 ? selected.map(labelOf).join(", ")
    : `${selected.length} selected`;

  const triggerProps: PopoverProps = { popovertarget: popoverId };
  const popoverProps: PopoverProps = { popover: "auto" };
  const closeProps: PopoverProps = { popovertarget: popoverId, popovertargetaction: "hide" };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="ctl-label">{label}</span>
      <button
        ref={triggerRef}
        {...triggerProps}
        className="ctl"
        data-testid={testId}
        aria-pressed={active || undefined}
        title={selected.length > 2 ? selected.map(labelOf).join(", ") : undefined}
      >
        {summary} ▾
      </button>
      <div
        ref={popoverRef}
        id={popoverId}
        {...popoverProps}
        data-testid={testId ? `${testId}-list` : undefined}
        style={{
          // Reset the UA popover defaults so our placement sticks.
          position: "fixed",
          inset: "unset",
          margin: 0,
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 6,
          padding: 8,
          width: "max-content",
          minWidth: 160,
          maxWidth: `min(${POP_MAX_WIDTH}px, calc(100vw - 16px))`,
          overflowY: "auto",
          boxShadow: "0 4px 20px rgba(0,0,0,0.22)",
          color: t.text,
        }}
      >
        <div style={{ display: "flex", gap: 6, justifyContent: "space-between", marginBottom: 8 }}>
          <button onClick={() => onChange([])} disabled={selected.length === 0} className="ctl" style={{ fontSize: 10 }}>
            {allLabel}
          </button>
          <button {...closeProps} className="ctl" style={{ fontSize: 10 }}>Close</button>
        </div>
        {options.map((o) => {
          const on = selectedSet.has(o.value);
          return (
            <label
              key={o.value}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "4px 6px", borderRadius: 3, cursor: "pointer",
                fontFamily: FONTS.mono, fontSize: 11,
                color: on ? t.text : t.textMuted,
                background: on ? t.bgAlt : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(o.value)}
                style={{ cursor: "pointer", accentColor: t.primary, margin: 0 }}
              />
              {o.color && <span aria-hidden style={{ color: o.color }}>■</span>}
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
