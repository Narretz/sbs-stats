import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ResponsiveContainer,
} from "recharts";
import { useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS, type Theme } from "@/theme";
import type { MediazonaEstimateRow } from "@/types";

// The most recent ~6 months are provisional on BOTH series: the estimate is only
// partly registry-backed there (probate filings take 180+ days to complete) and
// partly model-based, and the recorded-names count is still being filled in.
// We shade that window and explain it in the caption.
const PROVISIONAL_WEEKS = 26; // ~6 months
const PROVISIONAL_MONTHS = 6;

const NAMES = "#3f9b52";    // recorded names count (probate file `real`) — green, per Mediazona
const ESTIMATE = "#c44e52"; // estimate of actual losses (`rnd`) — the all-in topline

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type Row = {
  week: string;
  documented: number | null; // recorded names
  estimate: number | null;
  gap: number | null; // max(estimate - documented, 0), the shaded undercount band
};

function fmtDate(v: string): string {
  const [y, m] = v.split("-");
  return `${m}/${y.slice(2)}`;
}
function fmtFullDate(v: string): string {
  const [y, m, d] = v.split("-");
  return `${d}.${m}.${y}`;
}
function fmtMonthYear(v: string): string {
  const [y, m] = v.split("-");
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}
function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? Math.round(n).toLocaleString() : "—";
}

function BandTooltip({
  active, payload, t, bucket,
}: {
  active?: boolean;
  payload?: { payload?: Row }[];
  t: Theme;
  bucket: "weekly" | "monthly";
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const row = payload[0].payload;
  const mult = row.documented && row.estimate ? row.estimate / row.documented : null;
  const header = bucket === "monthly"
    ? `Month of ${fmtMonthYear(row.week)}`
    : `Week of ${fmtFullDate(row.week)}`;
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 6,
      padding: "8px 10px", fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)", minWidth: 200,
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>{header}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: ESTIMATE }}>
        <span>Estimated losses</span><span>{fmt(row.estimate)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: NAMES }}>
        <span>Recorded names</span><span>{fmt(row.documented)}</span>
      </div>
      {mult != null && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: t.textMuted, marginTop: 2 }}>
          <span>Undercount</span><span>×{mult.toFixed(1)}</span>
        </div>
      )}
    </div>
  );
}

export function DocumentedVsEstimatedChart({
  rows,
  bucket = "weekly",
}: {
  rows: MediazonaEstimateRow[];
  bucket?: "weekly" | "monthly";
}) {
  const { theme: t } = useTheme();

  const { data, totDoc, totEst } = useMemo(() => {
    let totDoc = 0, totEst = 0;
    const data: Row[] = rows.map((r) => {
      if (typeof r.documented === "number") totDoc += r.documented;
      if (typeof r.estimate === "number") totEst += r.estimate;
      const gap = typeof r.estimate === "number" && typeof r.documented === "number"
        ? Math.max(r.estimate - r.documented, 0) : null;
      return { week: r.week, documented: r.documented, estimate: r.estimate, gap };
    });
    return { data, totDoc, totEst };
  }, [rows]);

  const provisionalSpan = bucket === "monthly" ? PROVISIONAL_MONTHS : PROVISIONAL_WEEKS;
  const provisionalFrom = data.length > provisionalSpan ? data[data.length - provisionalSpan].week : null;
  const lastWeek = data.length ? data[data.length - 1].week : null;

  return (
    <div className="daily-card" style={{
      background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
      padding: "18px 16px 12px", gridColumn: "1 / -1",
      animation: "fadeIn 0.3s ease both", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
        Recorded names vs. estimated losses
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: ESTIMATE }}>● Estimated losses <span style={{ opacity: 0.8 }}>· total {fmt(totEst)}</span></span>
        <span style={{ color: NAMES }}>● Recorded names <span style={{ opacity: 0.8 }}>· total {fmt(totDoc)}</span></span>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -6, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="week"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false} minTickGap={28} tickFormatter={fmtDate}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
            tickFormatter={(v: number) => v.toLocaleString()} />
          <Tooltip
            cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
            content={(props) => (
              <BandTooltip active={props.active} payload={props.payload as { payload?: Row }[] | undefined} t={t} bucket={bucket} />
            )}
          />
          {provisionalFrom && lastWeek && (
            <ReferenceArea x1={provisionalFrom} x2={lastWeek} fill={t.textMuted} fillOpacity={0.12} ifOverflow="extendDomain" />
          )}
          {/* Stacked band: names (solid base) + gap (translucent) → top = estimate level */}
          <Area type="monotone" dataKey="documented" stackId="band" stroke={NAMES} strokeWidth={1.5}
            fill={NAMES} fillOpacity={0.14} isAnimationActive={false} connectNulls />
          <Area type="monotone" dataKey="gap" stackId="band" stroke="none"
            fill={ESTIMATE} fillOpacity={0.16} isAnimationActive={false} connectNulls />
          {/* Estimate line drawn on top so it stays crisp even where it dips below names */}
          <Line type="monotone" dataKey="estimate" stroke={ESTIMATE} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
