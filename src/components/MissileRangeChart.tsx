import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, type DotProps,
} from "recharts";
import { useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS, type Theme } from "@/theme";
import type { MissileSeries, MissilePoint } from "@/data/missiles";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// as_of read at its stated precision — a mid-month estimate shouldn't masquerade
// as a specific day.
function fmtAsOf(p: MissilePoint): string {
  const [y, m, d] = p.as_of.split("-");
  if (p.as_of_precision === "day") return `${d}.${m}.${y}`;
  if (p.as_of_precision === "mid_month") return `mid-${MONTHS[+m]} ${y}`;
  return `${MONTHS[+m]} ${y}`;
}

// The bound qualifier, made legible. A bar/point alone can't say "≤"; this can.
function fmtValue(p: MissilePoint): string {
  switch (p.bound) {
    case "range":    return `${p.low}–${p.high}`;
    case "up_to":    return `≤ ${p.high}`;
    case "at_least": return `≥ ${p.low}`;
    case "approx":   return `~ ${p.mid}`;
    case "planned":  return `${p.mid} (planned)`;
    default:         return `${p.mid}`;
  }
}

// Bound → dot shape. This is what keeps "up to 500" and "more than 400" from
// reading as the same point: ▽ = ceiling, △ = floor, ■ = exact, ○ = planned,
// ● = approx/range (range also gets a vertical band).
function BoundDot(props: DotProps & { payload?: MissilePoint; color: string }) {
  const { cx, cy, payload, color } = props;
  if (cx == null || cy == null || !payload) return null;
  const r = 4;
  switch (payload.bound) {
    case "up_to":
      return <path d={`M${cx - r},${cy - r} L${cx + r},${cy - r} L${cx},${cy + r} Z`} fill={color} />;
    case "at_least":
      return <path d={`M${cx - r},${cy + r} L${cx + r},${cy + r} L${cx},${cy - r} Z`} fill={color} />;
    case "exact":
      return <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} fill={color} />;
    case "planned":
      return <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.6} />;
    default:
      return <circle cx={cx} cy={cy} r={r - 0.5} fill={color} />;
  }
}

function MissileTooltip({ active, payload, t, unit }: {
  active?: boolean;
  payload?: Array<{ payload?: MissilePoint }>;
  t: Theme;
  unit: string;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const p = payload[0].payload;
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 6,
      padding: "8px 10px", fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)", minWidth: 180,
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>{fmtAsOf(p)}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: t.text }}>
        <span>{fmtValue(p)}</span><span style={{ color: t.textMuted }}>{unit}</span>
      </div>
      <div style={{ color: t.textMuted, marginTop: 4, fontSize: 11 }}>“{p.raw_label}”</div>
      <div style={{ color: t.textFaint, marginTop: 2, fontSize: 10 }}>
        {p.org} · disclosed {p.reported_at}
      </div>
    </div>
  );
}

interface Props {
  series: MissileSeries;
  unit: string;
  timeDomain: [number, number];
  ticks: number[];
  // Shared y-max across the grid (for cross-panel comparison). When omitted the
  // panel fits its own data.
  yMax?: number;
  // Per-type category swatch shown next to the title, matching the checkbox
  // list and the bars view so the colour is consistent across all three.
  swatch?: string;
}

export function MissileRangeChart({ series, unit, timeDomain, ticks, yMax, swatch }: Props) {
  const { theme: t } = useTheme();
  const color = series.combined ? t.muted : t.primary;

  const ownMax = useMemo(
    () => Math.ceil(Math.max(1, ...series.points.map((p) => p.high)) * 1.15),
    [series.points],
  );
  const domainMax = yMax ?? ownMax;
  const single = series.points.length < 2;

  return (
    <div className="daily-card" style={{
      background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
      padding: "18px 16px 12px", animation: "fadeIn 0.3s ease both",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted,
        letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 2,
      }}>
        {swatch && (
          <span style={{
            width: 14, height: 14, borderRadius: 2, flexShrink: 0,
            background: swatch, border: `1px solid ${swatch}`,
          }} />
        )}
        {series.label}
      </div>
      <div style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textFaint, marginBottom: 8 }}>
        {series.combined ? "reported combined · " : ""}{series.points.length} report{series.points.length === 1 ? "" : "s"}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={series.points} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis
            type="number" dataKey="t" scale="time" domain={timeDomain} ticks={ticks}
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: number) => {
              const d = new Date(v);
              return `${MONTHS[d.getUTCMonth() + 1]} '${String(d.getUTCFullYear()).slice(2)}`;
            }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            domain={[0, domainMax]} allowDecimals={false}
          />
          <Tooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 9999 }}
            cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
            content={(props) => (
              <MissileTooltip
                active={props.active}
                payload={props.payload as Array<{ payload?: MissilePoint }> | undefined}
                t={t} unit={unit}
              />
            )}
          />
          {/* Range band — only visibly tall where a report gave a low–high range. */}
          <Area type="linear" dataKey="range" stroke="none" fill={color} fillOpacity={0.18} isAnimationActive={false} />
          {/* Central line through the points; gaps between reports are real time
              spans, never zero-fills. A lone point shows as just its dot. */}
          <Line
            type="linear" dataKey="mid" stroke={color} strokeWidth={single ? 0 : 1.8}
            isAnimationActive={false}
            dot={({ key, ...p }) => <BoundDot key={key} {...p} color={color} />}
            activeDot={{ r: 5, fill: color }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
