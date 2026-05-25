import {
  LineChart, Line, ComposedChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, type DotProps,
} from "recharts";
import { useMemo } from "react";
import type { DailyDataPoint, EodEstimate, PairMode } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { FONTS, type Theme } from "@/theme";

function linearRegression(data: DailyDataPoint[]): Array<number | null> {
  const points = data
    .map((d, i) => ({ x: i, y: d.value }))
    .filter((p): p is { x: number; y: number } => typeof p.y === "number");
  const n = points.length;
  if (n < 2) return data.map(d => d.value);
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return data.map((d, i) =>
    d.value == null ? null : Math.max(0, Math.round(slope * i + intercept))
  );
}

interface Props {
  title: string;
  data: DailyDataPoint[];
  globalMax: number;
  globalMedian: number;
  wfull: boolean;
  data2?: DailyDataPoint[];
  primaryLabel?: string;
  label2?: string;
  globalMax2?: number;
  globalMedian2?: number;
  pairMode?: PairMode;
  // End-of-day estimate for the "today" point (primary / paired series).
  eod?: EodEstimate | null;
  eod2?: EodEstimate | null;
}
const DESTROYED_COLOR = "#dc2626";
const DESTROYED_TREND_COLOR = "#fca5a5";

function CustomDot(props: DotProps & { payload?: DailyDataPoint; accentColor: string; primaryColor: string; bgColor: string }) {
  const { cx, cy, payload, accentColor, primaryColor, bgColor } = props;
  if (cx == null || cy == null) return null;
  if (payload?.is_today)
    return <circle cx={cx} cy={cy} r={5} fill={accentColor} stroke={bgColor} strokeWidth={2} />;
  return <circle cx={cx} cy={cy} r={2} fill={primaryColor} opacity={0.5} />;
}

type PairedRow = {
  date: string;
  value: number | null;
  value2: number | null;
  valueDiff: number | null;
  trend1: number | null;
  trend2: number | null;
  is_today: boolean;
  eod: EodEstimate | null;
  eod2: EodEstimate | null;
};

interface TooltipPayloadEntry {
  payload?: PairedRow;
}

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function formatDate(v: string): string {
  const [y, m, d] = v.split("-");
  return `${d}.${m}.${y}`;
}

function tipRow(color: string, label: string, val: string) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color }}>
      <span>{label}</span><span>{val}</span>
    </div>
  );
}

// Tooltip line for the end-of-day estimate (only shown on the "today" point).
function eodRow(color: string, label: string, e: EodEstimate) {
  return tipRow(color, `${label} · EoD est`, `~${fmt(e.projected)} (${Math.round(e.fraction * 100)}%)`);
}

function SingleTooltip({
  active, payload, t, primaryColor, primaryLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  t: Theme;
  primaryColor: string;
  primaryLabel: string;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: "8px 10px",
      fontFamily: FONTS.mono,
      fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      minWidth: 160,
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>{formatDate(d.date)}</div>
      {tipRow(primaryColor, primaryLabel, fmt(d.value))}
      {tipRow(t.muted, "Trend", fmt(d.trend1))}
      {d.is_today && d.eod && eodRow(t.accent, primaryLabel, d.eod)}
    </div>
  );
}

function PairedTooltip({
  active, payload, t, primaryColor, primaryLabel, secondaryLabel, pairMode,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  t: Theme;
  primaryColor: string;
  primaryLabel: string;
  secondaryLabel: string;
  pairMode: PairMode;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const d = payload[0].payload;
  const v = d.value;
  const v2 = d.value2;
  const tr1 = d.trend1;
  const tr2 = d.trend2;
  const total = pairMode === "subset"
    ? v
    : (typeof v === "number" && typeof v2 === "number" ? v + v2 : null);
  const pct = typeof total === "number" && total > 0 && typeof v2 === "number"
    ? (v2 / total) * 100
    : null;
  return (
    <div style={{
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: "8px 10px",
      fontFamily: FONTS.mono,
      fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      minWidth: 180,
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>{formatDate(d.date)}</div>
      {pairMode === "sum" && tipRow(t.text, "Total", fmt(total))}
      {tipRow(primaryColor, primaryLabel, fmt(v))}
      {tipRow(DESTROYED_COLOR, secondaryLabel, fmt(v2))}
      {pct !== null && tipRow(t.textMuted, `% ${secondaryLabel}`, `${pct.toFixed(1)}%`)}
      {tipRow(t.muted, `Trend (${primaryLabel})`, fmt(tr1))}
      {tipRow(DESTROYED_TREND_COLOR, `Trend (${secondaryLabel})`, fmt(tr2))}
      {d.is_today && d.eod && eodRow(primaryColor, primaryLabel, d.eod)}
      {d.is_today && d.eod2 && eodRow(DESTROYED_COLOR, secondaryLabel, d.eod2)}
    </div>
  );
}

// Elevate the hovered card so a tooltip overflowing its bottom edge isn't
// painted over by the next chart card (a later sibling in the grid).
const STYLE_ID = "daily-chart-hover-style";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `.daily-card { position: relative; z-index: 1; } .daily-card:hover { z-index: 100; }`;
  document.head.appendChild(s);
}

export function DailyLineChart({
  title, data, globalMax, globalMedian, wfull,
  data2, primaryLabel, label2, globalMax2, globalMedian2, pairMode = "subset",
  eod, eod2,
}: Props) {
  const { theme: t } = useTheme();
  const max = globalMax;
  const median = globalMedian;
  const hasPair = !!data2;
  // Single-line charts use the accent (red). On paired charts the whole "Hit"
  // series (line + area) is blue so it stays distinguishable from the red
  // "Destroyed" series.
  const primaryColor = t.accent;
  const hitFill = t.primary;
  const resolvedPrimaryLabel = primaryLabel ?? (hasPair ? "Hit" : title);
  const resolvedSecondaryLabel = label2 ?? "Destroyed";

  const chartData = useMemo(() => {
    const trend1 = linearRegression(data);
    const trend2 = data2 ? linearRegression(data2) : null;
    return data.map<PairedRow>((d, i) => {
      const v2 = data2?.[i]?.value ?? null;
      const v = d.value;
      const diff = pairMode === "subset"
        ? (typeof v === "number" && typeof v2 === "number" ? Math.max(0, v - v2) : null)
        : v;
      return {
        date: d.date,
        is_today: d.is_today,
        value: v,
        value2: v2,
        trend1: trend1[i] ?? null,
        trend2: trend2?.[i] ?? null,
        valueDiff: diff,
        eod: d.is_today ? (eod ?? null) : null,
        eod2: d.is_today ? (eod2 ?? null) : null,
      };
    });
  }, [data, data2, pairMode, eod, eod2]);

  const yMax = hasPair && pairMode === "sum"
    ? Math.max(globalMax + (globalMax2 ?? 0), 0)
    : globalMax;

  return (
    <div className="daily-card" style={{
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: wfull ? "1 / -1" : undefined,
      animation: "fadeIn 0.3s ease both",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        {hasPair && <span style={{ color: hitFill }}>● {resolvedPrimaryLabel}</span>}
        <span style={{ color: t.accent }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: t.muted }}>~ MED {median.toLocaleString()}</span>
        {hasPair && (
          <>
            <span style={{ color: DESTROYED_COLOR, marginLeft: 8 }}>● {resolvedSecondaryLabel}</span>
            <span style={{ color: DESTROYED_COLOR }}>▲ MAX {(globalMax2 ?? 0).toLocaleString()}</span>
            <span style={{ color: DESTROYED_COLOR, opacity: 0.7 }}>~ MED {(globalMedian2 ?? 0).toLocaleString()}</span>
          </>
        )}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        {hasPair ? (
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
            <XAxis dataKey="date"
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
            />
            <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax, yMax)]} />
            <Tooltip
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 9999 }}
              cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
              content={(props) => (
                <PairedTooltip
                  active={props.active}
                  payload={props.payload as TooltipPayloadEntry[] | undefined}
                  t={t}
                  primaryColor={hitFill}
                  primaryLabel={resolvedPrimaryLabel}
                  secondaryLabel={resolvedSecondaryLabel}
                  pairMode={pairMode}
                />
              )}
            />
            <ReferenceLine y={max} stroke={t.accent} strokeDasharray="4 4" strokeOpacity={0.6}
              label={{ value: "MAX", position: "insideTopRight", fontSize: 9, fill: t.accent, fontFamily: FONTS.mono }} />
            <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
            <Area type="monotone" dataKey="value2" name={resolvedSecondaryLabel} stackId="1"
              stroke={DESTROYED_COLOR} strokeWidth={1.5} fill={DESTROYED_COLOR} fillOpacity={0.55} isAnimationActive={false} />
            <Area type="monotone" dataKey="valueDiff" name={resolvedPrimaryLabel} stackId="1"
              stroke={hitFill} strokeWidth={1.5} fill={hitFill} fillOpacity={0.35} isAnimationActive={false} />
          </ComposedChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
            <XAxis dataKey="date"
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
            />
            <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax, globalMax)]} />
            <Tooltip
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 9999 }}
              cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
              content={(props) => (
                <SingleTooltip
                  active={props.active}
                  payload={props.payload as TooltipPayloadEntry[] | undefined}
                  t={t}
                  primaryColor={primaryColor}
                  primaryLabel={resolvedPrimaryLabel}
                />
              )}
            />
            <ReferenceLine y={max} stroke={t.accent} strokeDasharray="4 4" strokeOpacity={0.6}
              label={{ value: "MAX", position: "insideTopRight", fontSize: 9, fill: t.accent, fontFamily: FONTS.mono }} />
            <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
            <Line type="monotone" dataKey="value" name={resolvedPrimaryLabel} stroke={primaryColor} strokeWidth={2}
              dot={({ key, ...props }) => <CustomDot key={key} {...props} accentColor={t.accent} primaryColor={primaryColor} bgColor={t.surface} />}
              activeDot={{ r: 5, fill: primaryColor }}
            />
            <Line type="linear" dataKey="trend1" name="Trend" stroke={t.muted} strokeWidth={1.5}
              strokeDasharray="6 3" dot={false} activeDot={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
