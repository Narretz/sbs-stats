import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, ReferenceArea, ResponsiveContainer,
} from "recharts";
import { useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import type { MediazonaEstimateRow } from "@/types";
import type { TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";
import { usePinnedChart } from "@/components/usePinnedChart";

// The most recent ~6 months are provisional on BOTH series: the estimate is only
// partly registry-backed there (probate filings take 180+ days to complete) and
// partly model-based, and the recorded-names count is still being filled in.
// We shade that window and explain it in the caption.
const PROVISIONAL_WEEKS = 26; // ~6 months
const PROVISIONAL_MONTHS = 6;


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

function describeBand(
  row: Row,
  c: ReturnType<typeof chartColors>,
  bucket: "weekly" | "monthly",
): TooltipDescriptor {
  const mult = row.documented && row.estimate ? row.estimate / row.documented : null;
  const header = bucket === "monthly"
    ? `Month of ${fmtMonthYear(row.week)}`
    : `Week of ${fmtFullDate(row.week)}`;
  const fmtInt = (n: number) => Math.round(n).toLocaleString();
  const rows: TooltipTableRow[] = [
    { label: "Estimated losses", color: c.lineSecondary, value: row.estimate },
    { label: "Recorded names",  color: c.line,          value: row.documented },
  ];
  if (mult != null) {
    // Pre-formatted string value — the "×N.N" ratio doesn't fit the numeric
    // formatter and stands apart from the counts above.
    rows.push({ label: "Undercount", color: c.neutral, value: `×${mult.toFixed(1)}` });
  }
  return { header, rows, formatValue: fmtInt, minWidth: 220 };
}

export function DocumentedVsEstimatedChart({
  rows,
  bucket = "weekly",
}: {
  rows: MediazonaEstimateRow[];
  bucket?: "weekly" | "monthly";
}) {
  const { theme: t } = useTheme();
  const c = chartColors(t);

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

  const pin = usePinnedChart({
    chartId: "mediazona-documented-vs-estimated",
    title: "Recorded names vs. estimated losses",
    data,
    xOf: (r) => r.week,
    describe: (r) => describeBand(r, c, bucket),
    formatLabel: (r) => bucket === "monthly" ? fmtMonthYear(r.week) : fmtFullDate(r.week),
    cursor: { stroke: t.textMuted, strokeWidth: 1 },
  });

  return (
    <div className="daily-card" {...pin.cardProps} style={{
      background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
      padding: "18px 16px 12px", gridColumn: "1 / -1",
      animation: "fadeIn 0.3s ease both", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      cursor: "pointer",
    }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
        Recorded names vs. estimated losses
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: c.lineSecondary }}>● Estimated losses <span style={{ opacity: 0.8 }}>· total {fmt(totEst)}</span></span>
        <span style={{ color: c.line }}>● Recorded names <span style={{ opacity: 0.8 }}>· total {fmt(totDoc)}</span></span>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -6, bottom: 0 }} {...pin.chartProps}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="week"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false} minTickGap={28} tickFormatter={fmtDate}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
            tickFormatter={(v: number) => v.toLocaleString()} />
          {pin.tooltip}
          {provisionalFrom && lastWeek && (
            <ReferenceArea x1={provisionalFrom} x2={lastWeek} fill={t.textMuted} fillOpacity={0.12} ifOverflow="extendDomain" />
          )}
          {/* Stacked band: names (solid base) + gap (translucent) → top = estimate level */}
          <Area type="monotone" dataKey="documented" stackId="band" stroke={c.line} strokeWidth={1.5}
            fill={c.line} fillOpacity={0.14} isAnimationActive={false} connectNulls />
          <Area type="monotone" dataKey="gap" stackId="band" stroke="none"
            fill={c.lineSecondary} fillOpacity={0.16} isAnimationActive={false} connectNulls />
          {/* Estimate line drawn on top so it stays crisp even where it dips below names */}
          <Line type="monotone" dataKey="estimate" stroke={c.lineSecondary} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          {/* Painted last so it reads as a crosshair over the series,
              not a stub buried under a bar. */}
          {pin.cursor}
        </ComposedChart>
      </ResponsiveContainer>
      {pin.sheet}
    </div>
  );
}
