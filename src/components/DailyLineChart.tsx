import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, type DotProps,
} from "recharts";
import { useMemo } from "react";
import type { DailyDataPoint } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

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
  highlight?: boolean;
  data2?: DailyDataPoint[];
  label2?: string;
  globalMax2?: number;
  globalMedian2?: number;
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
export function DailyLineChart({ title, data, globalMax, globalMedian, wfull, highlight = false, data2, label2, globalMax2, globalMedian2 }: Props) {
  const { theme: t } = useTheme();
  const max = globalMax;
  const median = globalMedian;
  const hasPair = !!data2;
  const primaryLabel = hasPair ? "Hit" : title;
  const chartData = useMemo(() => {
    const trend = linearRegression(data);
    const trend2 = data2 ? linearRegression(data2) : null;
    return data.map((d, i) => ({
      ...d,
      trend: trend[i],
      value2: data2?.[i]?.value ?? null,
      trend2: trend2?.[i] ?? null,
    }));
  }, [data, data2]);
  return (
    <div style={{
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
        {hasPair && <span style={{ color: highlight ? t.accent : t.primary }}>● {primaryLabel}</span>}
        <span style={{ color: t.accent }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: t.muted }}>~ MED {median.toLocaleString()}</span>
        {hasPair && (
          <>
            <span style={{ color: DESTROYED_COLOR, marginLeft: 8 }}>● {label2 ?? "Destroyed"}</span>
            <span style={{ color: DESTROYED_COLOR }}>▲ MAX {(globalMax2 ?? 0).toLocaleString()}</span>
            <span style={{ color: DESTROYED_COLOR, opacity: 0.7 }}>~ MED {(globalMedian2 ?? 0).toLocaleString()}</span>
          </>
        )}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} domain={[0, (dataMax: number) => Math.max(dataMax, globalMax)]} />
          <Tooltip
            allowEscapeViewBox={{ x: false, y: true }}
            contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 6, fontFamily: FONTS.mono, fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
            labelStyle={{ color: t.textMuted, marginBottom: 4 }}
            labelFormatter={(v: string) => { const [y, m, d] = v.split('-'); return `${d}.${m}.${y}`; }}
            filterNull={false}
          />
          <ReferenceLine y={max} stroke={t.accent} strokeDasharray="4 4" strokeOpacity={0.6}
            label={{ value: "MAX", position: "insideTopRight", fontSize: 9, fill: t.accent, fontFamily: FONTS.mono }} />
          <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
            label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
          <Line type="monotone" dataKey="value" name={primaryLabel} stroke={highlight ? t.accent : t.primary} strokeWidth={2}
            dot={({ key, ...props }) => <CustomDot key={key} {...props} accentColor={t.accent} primaryColor={highlight ? t.accent : t.primary} bgColor={t.surface} />}
            activeDot={{ r: 5, fill: highlight ? t.accent : t.primary }}
          />
          <Line type="linear" dataKey="trend" name="Trend" stroke={t.muted} strokeWidth={1.5}
            strokeDasharray="6 3" dot={false} activeDot={false}
          />
          {hasPair && (
            <Line type="monotone" dataKey="value2" name={label2 ?? "Destroyed"} stroke={DESTROYED_COLOR} strokeWidth={2}
              dot={({ key, ...props }) => <CustomDot key={key} {...props} accentColor={t.accent} primaryColor={DESTROYED_COLOR} bgColor={t.surface} />}
              activeDot={{ r: 5, fill: DESTROYED_COLOR }}
            />
          )}
          {hasPair && (
            <Line type="linear" dataKey="trend2" name="Trend (destroyed)" stroke={DESTROYED_TREND_COLOR} strokeWidth={1.5}
              strokeDasharray="6 3" dot={false} activeDot={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
