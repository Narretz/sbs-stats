import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ResponsiveContainer,
} from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";

// `total` is included so the tooltip can show it explicitly, even though
// (destroyed + damaged) equals it by construction (SBU's own phrasing).
export interface TargetsStackPoint {
  date: string;
  destroyed: number | null;
  damaged: number | null;
  total: number | null;
}

interface Props {
  title: string;
  data: TargetsStackPoint[];
  wfull?: boolean;
}

const StackTooltip = ({
  active, payload, t, c,
}: {
  active?: boolean;
  payload?: Array<{ payload: TargetsStackPoint }>;
  t: ReturnType<typeof useTheme>["theme"];
  c: ReturnType<typeof chartColors>;
}) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const num = (n: number | null) => (n == null ? "n/a" : n.toLocaleString());
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`,
      borderRadius: 6, padding: "10px 14px",
      fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    }}>
      <div style={{ color: t.textMuted, marginBottom: 6 }}>{d.date}</div>
      <div style={{ color: c.destroyed }}>
        Destroyed: <span style={{ color: t.text, fontWeight: 700 }}>{num(d.destroyed)}</span>
      </div>
      <div style={{ color: c.damaged }}>
        Damaged: <span style={{ color: t.text, fontWeight: 700 }}>{num(d.damaged)}</span>
      </div>
      <div style={{ color: t.textMuted, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${t.border}` }}>
        Total: <span style={{ color: t.text, fontWeight: 700 }}>{num(d.total)}</span>
      </div>
    </div>
  );
};

export function SbuAlfaTargetsStackedChart({ title, data, wfull }: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const lastIdx = data.length - 1;

  // `destroyed` on the bottom (the "permanent" half), `damaged` on top —
  // reading bottom-up matches "fully neutralised → partially neutralised".
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
      <div style={{
        fontFamily: FONTS.display, fontWeight: 700, fontSize: 12,
        color: t.textMuted, letterSpacing: "0.07em",
        textTransform: "uppercase", marginBottom: 14,
      }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 10 }}>
        <span style={{ color: c.destroyed }}>■ Destroyed</span>
        <span style={{ color: c.damaged }}>■ Damaged</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} />
          <XAxis dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: string) => v.slice(0, 7).replace("-", "/")}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} />
          <Tooltip
            content={({ active, payload }) => (
              <StackTooltip
                active={active}
                payload={payload as unknown as Array<{ payload: TargetsStackPoint }>}
                t={t}
                c={c}
              />
            )}
            allowEscapeViewBox={{ x: false, y: true }}
          />
          <Bar dataKey="destroyed" stackId="a" name="Destroyed">
            {data.map((_, i) => (
              <Cell key={`d-${i}`} fill={c.destroyed} opacity={i === lastIdx ? 1 : 0.85} />
            ))}
          </Bar>
          <Bar dataKey="damaged" stackId="a" name="Damaged" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={`m-${i}`} fill={c.damaged} opacity={i === lastIdx ? 1 : 0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
