import { useState, useEffect, useRef } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

interface Props {
  lastRefreshed: Date | null;
  refreshCount: number;
  onRefresh: () => void;
  isLoading: boolean;
  // Auto-refresh interval of the active site's loader (varies per site).
  intervalMs: number;
}

export function RefreshIndicator({ lastRefreshed, refreshCount, onRefresh, isLoading, intervalMs }: Props) {
  const { theme: t } = useTheme();
  const [progress, setProgress] = useState(1);
  const [secondsLeft, setSecondsLeft] = useState(intervalMs / 1000);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setProgress(1);
    setSecondsLeft(intervalMs / 1000);
  }, [lastRefreshed, refreshCount, intervalMs]);

  useEffect(() => {
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

  const size = 28;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * progress;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginLeft: 8,
        padding: "3px 10px 3px 6px",
        border: `1px solid ${t.border}`,
        borderRadius: 4,
        background: t.bgAlt,
        cursor: "pointer",
        userSelect: "none",
        transition: "border-color 0.15s",
      }}
      onClick={!isLoading ? onRefresh : undefined}
      title={`Last updated: ${lastUpdatedStr} · Click to refresh now`}
    >
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.border} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={isLoading ? t.accent : t.primary}
          strokeWidth={stroke}
          strokeDasharray={`${isLoading ? circ * 0.25 : dash} ${circ}`}
          strokeLinecap="round"
          style={isLoading ? { animation: "spin 1s linear infinite" } : { transition: "stroke-dasharray 0.8s linear" }}
        />
        <g transform={`rotate(90, ${size / 2}, ${size / 2}) translate(${size / 2}, ${size / 2})`}>
          <path
            d="M-3.5,0 A3.5,3.5 0 1,1 1.8,3 M1.8,3 L0,5 M1.8,3 L3.8,1.5"
            fill="none"
            stroke={isLoading ? t.accent : t.textMuted}
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 64 }}>
        <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, lineHeight: 1 }}>
          {isLoading ? "refreshing…" : `refresh in ${formatTime(secondsLeft)}`}
        </span>
        <span style={{ fontFamily: FONTS.mono, fontSize: 9, color: t.textMuted + "99", lineHeight: 1 }}>
          {lastRefreshed ? `updated ${lastUpdatedStr}` : "loading…"}
        </span>
      </div>
    </div>
  );
}
