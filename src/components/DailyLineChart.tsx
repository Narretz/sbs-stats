import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, type DotProps,
} from "recharts";
import type { DailyDataPoint } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
interface Props {
  title: string;
  data: DailyDataPoint[];
  globalMax: number;
  globalMedian: number;
  wfull: boolean;
}
function CustomDot(props: DotProps & { payload?: DailyDataPoint; accentColor: string; primaryColor: string; bgColor: string }) {
  const { cx, cy, payload, accentColor, primaryColor, bgColor } = props;
  if (cx == null || cy == null) return null;
  if (payload?.is_today)
    return <circle cx={cx} cy={cy} r={5} fill={accentColor} stroke={bgColor} strokeWidth={2} />;
  return <circle cx={cx} cy={cy} r={2} fill={primaryColor} opacity={0.5} />;
}
export function DailyLineChart({ title, data, globalMax, globalMedian, wfull }: Props) {
  const { theme: t } = useTheme();
  const max = globalMax;
  const median = globalMedian;
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
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11 }}>
        <span style={{ color: t.accent }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: t.muted }}>~ MED {median.toLocaleString()}</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} domain={[0, (dataMax: number) => Math.max(dataMax, globalMax)]} />
          <Tooltip
            contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 6, fontFamily: FONTS.mono, fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
            labelStyle={{ color: t.textMuted, marginBottom: 4 }}
            itemStyle={{ color: t.primary }}
            labelFormatter={(v: string) => { const [y, m, d] = v.split('-'); return `${d}.${m}.${y}`; }}
          />
          <ReferenceLine y={max} stroke={t.accent} strokeDasharray="4 4" strokeOpacity={0.6}
            label={{ value: "MAX", position: "insideTopRight", fontSize: 9, fill: t.accent, fontFamily: FONTS.mono }} />
          <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
            label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
          <Line type="monotone" dataKey="value" name={title} stroke={t.primary} strokeWidth={2}
            dot={(props) => <CustomDot {...props} accentColor={t.accent} primaryColor={t.primary} bgColor={t.surface} />}
            activeDot={{ r: 5, fill: t.primary }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
