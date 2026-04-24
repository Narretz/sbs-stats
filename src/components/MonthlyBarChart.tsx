import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ResponsiveContainer,
} from "recharts";
import type { MonthlyDataPoint } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

interface Props {
  title: string;
  data: MonthlyDataPoint[];
  wfull: boolean;
}

const MonthlyTooltip = ({
  active, payload, t,
}: {
  active?: boolean;
  payload?: Array<{ payload: MonthlyDataPoint }>;
  t: ReturnType<typeof useTheme>["theme"];
}) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`,
      borderRadius: 6, padding: "10px 14px",
      fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    }}>
      <div style={{ color: t.textMuted, marginBottom: 6 }}>{d.date}</div>
      <div style={{ color: t.primary }}>
        Actual: <span style={{ color: t.text, fontWeight: 700 }}>{d.value?.toLocaleString()}</span>
      </div>
      {d.projected != null && (
        <>
          <div style={{ color: t.accent }}>
            Projected: <span style={{ color: t.text, fontWeight: 700 }}>{d.projected.toLocaleString()}</span>
          </div>
          <div style={{ color: t.textMuted, fontSize: 10, marginTop: 4 }}>
            Day {d.projection_day} of {d.projection_days_in_month}
          </div>
        </>
      )}
    </div>
  );
};

export function MonthlyBarChart({ title, data, wfull }: Props) {
  const { theme: t } = useTheme();
  const lastIdx = data.length - 1;

  // Projected gap color with transparency
  const projectedFill = t.accent + "55";

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
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 14 }}>
        {title}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: string) => v.slice(0, 7).replace("-", "/")}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} />
          <Tooltip
            content={(props) => <MonthlyTooltip {...props} t={t} />}
            allowEscapeViewBox={{ x: false, y: true }}
          />
          <Bar dataKey="value" stackId="a" name="Actual">
            {data.map((_, i) => (
              <Cell key={`val-${i}`} fill={i === lastIdx ? t.accent : t.primary} opacity={i === lastIdx ? 1 : 0.8} />
            ))}
          </Bar>
          <Bar dataKey="gap" stackId="a" name="Projected" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={`gap-${i}`} fill={i === lastIdx ? projectedFill : "transparent"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
