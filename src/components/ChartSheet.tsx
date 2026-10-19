import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useChartPinContext, useSheetHost, useSheetOpen } from "@/hooks/ChartPinProvider";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import type { SheetLink } from "@/hooks/useDrillDownLink";

const TITLE_ID = "chart-sheet-title";

// What counts as a control for outside-click dismissal. `[popover]` covers the
// padding of the native popovers (weekday filter, metric picker) around their
// checkboxes, and `label` the text of a checkbox row.
const CONTROL = "button, select, input, textarea, label, a[href], summary, [role=button], [popover]";

// The singleton bottom sheet. Mounted once, above the pages (several pages
// bypass PageScaffold, so this can't live there), and empty until some chart
// pins itself and portals its header + body into `host`.
//
// Deliberately non-modal: the chart above it stays visible *and* clickable —
// clicking another point re-selects rather than dismissing — which is exactly
// what modal semantics exist to prevent. So: a labelled region, focus moved in
// on open and released on close, no focus trap, background never inert.
export function ChartSheet() {
  const { theme: t } = useTheme();
  const { store, setHost, sheetRef, stepRef } = useChartPinContext();
  const setPin = store.set;
  const open = useSheetOpen();

  // Extend the page's scroll range by the sheet's height so the last chart on
  // the page can still be scrolled clear of it. Padding the scroll container
  // rather than the charts avoids re-measuring every responsive chart.
  useEffect(() => {
    const el = sheetRef.current;
    if (!open || !el) {
      document.body.style.paddingBottom = "";
      return;
    }
    const apply = () => { document.body.style.paddingBottom = `${el.offsetHeight}px`; };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.body.style.paddingBottom = "";
    };
  }, [open, sheetRef]);

  // Outside-click dismissal. Clicks anywhere inside a chart card are exempt:
  // on the pinned chart that's a re-selection, on another chart it's a new
  // pin, and neither should be raced by a close. So are clicks on controls —
  // a button, a select, a popover's contents: adjusting the page around a
  // selection shouldn't throw it away. Whatever the control does to the pin
  // is settled downstream instead: a window that drops the pinned date drops
  // the pin (useChartPin), so does a control that removes the pinned chart,
  // and navigating to another page clears it (ChartPinProvider).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // A press on the page's scrollbar reports <html> as its target and sits
      // outside the document's client box. It is not an outside click — the
      // sheet used to close the moment you grabbed the scrollbar to read the
      // chart above it.
      const doc = document.documentElement;
      if (target === doc) return;
      if (e.clientX > doc.clientWidth || e.clientY > doc.clientHeight) return;
      if (sheetRef.current?.contains(target)) return;
      if (target.closest?.("[data-chart-pinnable]")) return;
      if (target.closest?.(CONTROL)) return;
      setPin(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, setPin, sheetRef]);

  // Focus follows the sheet so Escape and the arrow keys have somewhere to
  // land; arrows are scoped to the sheet rather than the window so they don't
  // hijack page scrolling for everyone else.
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) {
      restoreRef.current?.focus?.({ preventScroll: true });
      restoreRef.current = null;
      return;
    }
    restoreRef.current = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus({ preventScroll: true });
  }, [open, sheetRef]);

  // …and comes back to it after a click on a chart while it stays open — a
  // re-selection, the same point again, or another chart's pin. The click
  // moves focus off the sheet, and since the sheet never closes nothing above
  // would move it back: the arrows would go dead until you clicked the sheet.
  // A form control the click landed on (a picker inside a card) keeps it.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest?.("[data-chart-pinnable]")) return;
      const active = document.activeElement;
      if (active?.matches?.("input, select, textarea, button, a[href], [contenteditable]")) return;
      sheetRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open, sheetRef]);

  return (
    <div
      ref={sheetRef}
      className="chart-sheet"
      data-open={open ? "" : undefined}
      role="region"
      aria-labelledby={TITLE_ID}
      aria-hidden={!open}
      tabIndex={-1}
      style={{
        background: t.surface,
        borderTop: `1px solid ${t.border}`,
        fontFamily: FONTS.mono,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { setPin(null); return; }
        if (e.key === "ArrowLeft") { e.preventDefault(); stepRef.current?.(-1); }
        if (e.key === "ArrowRight") { e.preventDefault(); stepRef.current?.(1); }
      }}
    >
      <div className="chart-sheet-inner" ref={setHost} />
    </div>
  );
}

interface ContentProps {
  /** The chart's own title — names the sheet for assistive tech. */
  title: string;
  /** The selected x, formatted for humans (usually a date). Sits between the
   *  ‹ › stepper, matching the DateNav idiom used across the daily views. */
  label: ReactNode;
  canPrev: boolean;
  canNext: boolean;
  onStep: (delta: number) => void;
  onClose: () => void;
  /** The selected point's breakdown on the next finer view. */
  link?: SheetLink | null;
  children: ReactNode;
}

/**
 * Rendered *by the pinned chart* and portalled into the sheet. Keeping the
 * content on the chart's side of the tree means it re-renders from that
 * chart's own live data — no registry, no snapshot to go stale.
 */
export function ChartSheetContent({
  title, label, canPrev, canNext, onStep, onClose, link, children,
}: ContentProps) {
  const { theme: t } = useTheme();
  const { stepRef } = useChartPinContext();
  const host = useSheetHost();

  // Hand the stepper to the sheet's keyboard handler for the arrow keys.
  useEffect(() => {
    stepRef.current = onStep;
    return () => { stepRef.current = null; };
  }, [onStep, stepRef]);

  if (!host) return null;

  return createPortal(
    <div className="chart-sheet-content">
      <header className="chart-sheet-header" style={{ borderBottom: `1px solid ${t.border}`, background: t.surface }}>
        <div id={TITLE_ID} className="chart-sheet-title" style={{ color: t.textMuted }}>{title}</div>
      </header>
      {/* Stepping swaps this subtree instantly — no transition. Someone holding
          the next button walks through twenty days, and a per-step animation
          would turn that into visible lag. */}
      <div className="chart-sheet-body" aria-live="polite">
        {children}
      </div>
      {/* Controls live at the bottom, not under the title. The sheet is
          anchored to the viewport's bottom edge and sized to its content, so
          its *top* moves whenever the content height changes — stepping from a
          three-row day to a ten-row one would slide the ‹ › buttons out from
          under the cursor. Pinned down here they never move, and they land
          under the thumb on a phone. */}
      <footer className="chart-sheet-footer" style={{ borderTop: `1px solid ${t.border}`, background: t.surface }}>
        <div className="chart-sheet-stepper">
          <button
            className="ctl ctl-square" onClick={() => onStep(-1)} disabled={!canPrev}
            aria-label="Previous point" style={{ color: t.textMuted }}
          >&lt;</button>
          <span className="chart-sheet-label" style={{ color: t.text }}>{label}</span>
          <button
            className="ctl ctl-square" onClick={() => onStep(1)} disabled={!canNext}
            aria-label="Next point" style={{ color: t.textMuted }}
          >&gt;</button>
        </div>
        <div className="chart-sheet-actions">
          {link && (
            <a
              className="ctl ctl-dashed" href={link.href} title={link.title}
              // No inline colour: .ctl-dashed's own hover has to win.
              style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              onClick={(e) => {
                // Anything but a plain click (new tab, new window) is the
                // browser's to handle, through the href.
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                link.follow();
              }}
            >{link.label}</a>
          )}
          <button
            className="ctl ctl-square" onClick={onClose} aria-label="Close details"
            style={{ color: t.textMuted }}
          >✕</button>
        </div>
      </footer>
    </div>,
    host,
  );
}
