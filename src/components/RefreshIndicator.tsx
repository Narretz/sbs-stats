import { useState, useEffect, useRef } from "react";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  lastRefreshed: Date | null;
  refreshCount: number;
  onRefresh: () => void;
  isLoading: boolean;
  // Auto-refresh interval of the active site's loader (varies per site).
  // OMIT for manual-only mode (e.g. the home page, where multiple sources
  // each have their own underlying cadence so a single combined countdown
  // would be misleading) — the countdown ring + "refresh in M:SS" line
  // are hidden in that case and only the manual button + last-updated
  // stamp remain.
  intervalMs?: number;
}

export function RefreshIndicator({ lastRefreshed, refreshCount, onRefresh, isLoading, intervalMs }: Props) {
  const { theme: t } = useTheme();
  const manualOnly = intervalMs == null;
  const [progress, setProgress] = useState(1);
  const [secondsLeft, setSecondsLeft] = useState(intervalMs ? intervalMs / 1000 : 0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setProgress(1);
    if (intervalMs) setSecondsLeft(intervalMs / 1000);
  }, [lastRefreshed, refreshCount, intervalMs]);

  useEffect(() => {
    if (!intervalMs) return;
    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, intervalMs - elapsed);
      setProgress(remaining / intervalMs);
      setSecondsLeft(Math.ceil(remaining / 1000));
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [intervalMs]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const lastUpdatedStr = lastRefreshed
    ? lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  // Every label the control can show, so it can reserve the widest: the
  // countdown loses a digit as it runs down (1440:00 → 9:59) and "refreshing…"
  // is shorter still, and each change would resize the header. The font is
  // monospace, so a character count in `ch` is the width.
  const labelWidth = Math.max(
    "refreshing…".length,
    manualOnly ? "refresh".length : `refresh in ${formatTime(intervalMs / 1000)}`.length,
  );

  // The ring fits the control's line box (--ctl-line-height × font size), so
  // the control is exactly as tall as every other .ctl.
  const size = 20;
  const stroke = 2;
  // The arrowhead on the arc's fixed end (below): half its base, its length.
  // The ring is inset so the head's outer corner stays inside the box.
  const headHalf = 3.4;
  const headLength = 4.2;
  const r = size / 2 - headHalf - 0.4;
  const circ = 2 * Math.PI * r;
  // A full countdown ends at the arrowhead's tip rather than going all the way
  // round: the arc's moving end returns to 12 o'clock from the tip's side, so a
  // full circle spent its first stretch retreating unseen under the head.
  // Less the head's length, and half the stroke for the round cap.
  const fullArc = circ - headLength - stroke / 2;
  const dash = fullArc * progress;
  const label = isLoading ? "refreshing…" : manualOnly ? "refresh" : `refresh in ${formatTime(secondsLeft)}`;
  const updated = lastRefreshed ? `Last updated: ${lastUpdatedStr}` : "Loading…";

  // A standard control (.ctl): one line, the countdown ring as its icon. The
  // last-updated time, which had a second line of its own, is in the title.
  return (
    <button
      type="button"
      // .refresh-ctl: a square once the wrapped header hides the text (theme.css).
      className="ctl refresh-ctl"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, userSelect: "none" }}
      onClick={!isLoading ? onRefresh : undefined}
      aria-busy={isLoading}
      title={`${updated} · Click to refresh now`}
    >
      <svg width={size} height={size} aria-hidden style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.border} strokeWidth={stroke} />
        {/* Filled countdown arc — only when there's an interval to count down. */}
        {!manualOnly && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={isLoading ? t.accent : t.primary}
            strokeWidth={stroke}
            strokeDasharray={`${isLoading ? circ * 0.25 : dash} ${circ}`}
            strokeLinecap="round"
            // No transition on the countdown: stroke-dasharray can't animate
            // on the compositor, so easing each 1 s tick repainted the ring at
            // ~50 fps for 0.8 s of every second — measurable CPU on an idle
            // page, to move the arc a fraction of a pixel.
            style={isLoading ? { animation: "spin 1s linear infinite" } : undefined}
          />
        )}
        {/* Manual-only mode shows a spinner during loading, otherwise the bare ring. */}
        {manualOnly && isLoading && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={t.accent}
            strokeWidth={stroke}
            strokeDasharray={`${circ * 0.25} ${circ}`}
            strokeLinecap="round"
            style={{ animation: "spin 1s linear infinite" }}
          />
        )}
        {/* An arrowhead on the arc's fixed end — 12 o'clock, where the
            countdown starts and drains back to — pointing counter-clockwise,
            so the ring reads as a reload arrow (↺). In this frame the svg is
            turned −90°: the arc starts at (cx + r, cy) and runs toward +y, so
            the head points toward −y. Hidden while refreshing, when the ring
            spins. */}
        {!isLoading && (
          <path
            d={`M${size / 2 + r - headHalf},${size / 2} L${size / 2 + r + headHalf},${size / 2} L${size / 2 + r},${size / 2 - headLength} Z`}
            fill={manualOnly ? t.textMuted : t.primary}
          />
        )}
      </svg>
      {/* Layout lives in CSS (.refresh-text): an inline `display` would win
          over the media query that hides this in a wrapped header. */}
      <span className="refresh-text" style={{ color: t.textMuted, minWidth: `${labelWidth}ch`, textAlign: "left" }}>
        {label}
      </span>
    </button>
  );
}
