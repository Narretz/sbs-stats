import { useState, useEffect, useRef } from "react";
import { ThemeProvider, useTheme } from "@/hooks/useTheme";
import { DatabaseProvider } from "@/context/DatabaseContext";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { DailyPage } from "@/pages/DailyPage";
import { HourlyPage } from "@/pages/HourlyPage";
import { MonthlyPage } from "@/pages/MonthlyPage";
import { REFRESH_INTERVAL_MS } from "@/hooks/useDatabase";
import type { Page } from "@/types";
import { FONTS, GLOBAL_CSS } from "@/theme";

// Countdown ring that ticks down to the next auto-refresh
function RefreshIndicator({
  lastRefreshed,
  refreshCount,
  onRefresh,
  isLoading,
}: {
  lastRefreshed: Date | null;
  refreshCount: number;
  onRefresh: () => void;
  isLoading: boolean;
}) {
  const { theme: t } = useTheme();
  const [progress, setProgress] = useState(1); // 1 = full, 0 = empty
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_INTERVAL_MS / 1000);
  const startRef = useRef<number>(Date.now());

  // Reset countdown whenever lastRefreshed changes
  useEffect(() => {
    startRef.current = Date.now();
    setProgress(1);
    setSecondsLeft(REFRESH_INTERVAL_MS / 1000);
  }, [lastRefreshed, refreshCount]);

  useEffect(() => {
    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, REFRESH_INTERVAL_MS - elapsed);
      setProgress(remaining / REFRESH_INTERVAL_MS);
      setSecondsLeft(Math.ceil(remaining / 1000));
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const lastUpdatedStr = lastRefreshed
    ? lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  // SVG ring params
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
      {/* Countdown ring */}
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={t.border}
          strokeWidth={stroke}
        />
        {/* Progress arc */}
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

        {/* Refresh icon — drawn as SVG path, centered, counter-rotated */}
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

      {/* Text info */}
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

function AppInner() {
  const { mode, theme: t, toggle } = useTheme();
  const validPages: Page[] = ["daily", "hourly", "monthly"];
  const initParams = new URLSearchParams(window.location.search);
  const initPage = initParams.get("page") as Page;
  const [page, setPageState] = useState<Page>(validPages.includes(initPage) ? initPage : "hourly");
  const setPage = (p: Page) => {
    setPageState(p);
    const params = new URLSearchParams(window.location.search);
    params.set("page", p);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };
  const { loadState, refresh, lastRefreshed, refreshCount } = useDatabaseContext();

  const navBtn = (target: Page, label: string) => (
    <button
      key={target}
      onClick={() => setPage(target)}
      style={{
        background: page === target ? t.primary : "transparent",
        color: page === target ? "#ffffff" : t.textMuted,
        border: `1px solid ${page === target ? t.primary : t.border}`,
        borderRadius: 4,
        padding: "5px 14px",
        fontFamily: FONTS.display,
        fontSize: 12,
        fontWeight: page === target ? 700 : 400,
        cursor: "pointer",
        letterSpacing: "0.04em",
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <style>{GLOBAL_CSS(t)}
        {`@keyframes spin { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -${2 * Math.PI * 11}px; } }`}
      </style>
      <div style={{ minHeight: "100vh", background: t.bg }}>

        {/* Header */}
        <header style={{
          borderBottom: `1px solid ${t.border}`,
          padding: "0 24px",
          height: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backdropFilter: "blur(8px)",
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: t.headerBg,
        }}>
          {/* Brand */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: t.accent, animation: "blink 2s infinite",
            }} />
            <span style={{
              fontFamily: FONTS.display,
              fontSize: 13,
              fontWeight: 700,
              color: t.text,
              letterSpacing: "0.06em",
            }}>
              SBS STATISTICS
            </span>
          </div>

          {/* Nav + refresh indicator + theme toggle */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {navBtn("hourly", "HOURLY")}
            {navBtn("daily", "DAILY")}
            {navBtn("monthly", "MONTHLY")}

            {/* Refresh indicator */}
            <RefreshIndicator
              lastRefreshed={lastRefreshed}
              refreshCount={refreshCount}
              onRefresh={refresh}
              isLoading={loadState === "loading"}
            />

            {/* Theme toggle */}
            <button
              onClick={toggle}
              title={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
              style={{
                background: t.bgAlt,
                border: `1px solid ${t.border}`,
                borderRadius: 4,
                padding: "5px 10px",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                color: t.text,
              }}
            >
              {mode === "light" ? "🌙" : "☀️"}
            </button>
          </div>
        </header>

        {/* Main */}
        <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 20px 64px" }}>
          {page === "daily"   && <DailyPage refreshKey={refreshCount} />}
          {page === "hourly"  && <HourlyPage refreshKey={refreshCount} />}
          {page === "monthly" && <MonthlyPage refreshKey={refreshCount} />}
        </main>
      </div>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <DatabaseProvider>
        <AppInner />
      </DatabaseProvider>
    </ThemeProvider>
  );
}
