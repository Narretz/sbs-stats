import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS, type Theme } from "@/theme";
import type { MissileSeries, MissilePoint } from "@/data/missiles";
import { BoundDot } from "./MissileRangeChart";
import { fmtAsOf, fmtValue } from "./missileFormat";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// One combined panel per missile type: the type's stockpile (solid) and monthly
// production (dashed) overlaid on a shared base-10 log y-axis. The two metrics
// live an order of magnitude apart (production ~tens, stockpile ~hundreds), so a
// linear axis would flatten production to nothing — the log scale is what lets a
// single panel carry both. Points keep their bound glyph (▽ ≤ / △ ≥ / ● ~ / ■ /
// ○ planned); gaps between reports stay gaps (log drops nulls, never zero-fills).
interface Row {
  t: number;
  stock_mid?: number;
  prod_mid?: number;
  stock_p?: MissilePoint;
  prod_p?: MissilePoint;
}

function merge(stock?: MissileSeries, prod?: MissileSeries): Row[] {
  const byT = new Map<number, Row>();
  const add = (s: MissileSeries | undefined, isStock: boolean) => {
    if (!s) return;
    for (const p of s.points) {
      const row = byT.get(p.t) ?? { t: p.t };
      if (isStock) { row.stock_mid = p.mid; row.stock_p = p; }
      else { row.prod_mid = p.mid; row.prod_p = p; }
      byT.set(p.t, row);
    }
  };
  add(stock, true);
  add(prod, false);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function CombinedTooltip({ active, payload, t }: {
  active?: boolean;
  payload?: Array<{ payload?: Row }>;
  t: Theme;
}) {
  const row = active && payload?.length ? payload[0].payload : undefined;
  if (!row) return null;
  const ref = row.stock_p ?? row.prod_p;
  if (!ref) return null;
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 6,
      padding: "8px 10px", fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)", minWidth: 200,
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>{fmtAsOf(ref)}</div>
      {row.stock_p && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: t.text }}>
          <span>▬ {fmtValue(row.stock_p)}</span><span style={{ color: t.textMuted }}>in stockpile</span>
        </div>
      )}
      {row.prod_p && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: t.text }}>
          <span>┄ {fmtValue(row.prod_p)}</span><span style={{ color: t.textMuted }}>units / month</span>
        </div>
      )}
      <div style={{ color: t.textFaint, marginTop: 4, fontSize: 10 }}>
        {ref.org} · disclosed {ref.reported_at}
      </div>
    </div>
  );
}

interface Props {
  stock?: MissileSeries;
  prod?: MissileSeries;
  label: string;
  swatch?: string;
  timeDomain: [number, number];
  ticks: number[];
  // Shared log y-domain [floor, ceil] (powers of 10) across the grid, so a
  // narrow-range type (e.g. KN-23, ~50 only) isn't auto-zoomed into a fake
  // full-height wiggle and panel heights stay comparable. Omitted → auto-fit.
  yDomain?: [number, number];
}

export function MissileCombinedChart({ stock, prod, label, swatch, timeDomain, ticks, yDomain }: Props) {
  const { theme: t } = useTheme();
  const color = swatch ?? t.primary;
  const rows = useMemo(() => merge(stock, prod), [stock, prod]);
  const nStock = stock?.points.length ?? 0;
  const nProd = prod?.points.length ?? 0;

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
        {label}
      </div>
      <div style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textFaint, marginBottom: 8 }}>
        log · ▬ stockpile ({nStock}) · ┄ production/mo ({nProd})
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
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
            scale="log" domain={yDomain ?? ["auto", "auto"]} allowDataOverflow allowDecimals={false}
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
          />
          <Tooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 9999 }}
            cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
            content={(props) => (
              <CombinedTooltip
                active={props.active}
                payload={props.payload as Array<{ payload?: Row }> | undefined}
                t={t}
              />
            )}
          />
          {/* Stockpile: solid. connectNulls bridges reports that gave only production. */}
          <Line
            type="linear" dataKey="stock_mid" stroke={color} strokeWidth={1.8} connectNulls
            isAnimationActive={false}
            dot={({ key, ...p }) => <BoundDot key={key} {...p} payload={(p.payload as Row)?.stock_p} color={color} />}
            activeDot={{ r: 5, fill: color }}
          />
          {/* Production: dashed + slightly faded so the two read apart at a glance. */}
          <Line
            type="linear" dataKey="prod_mid" stroke={color} strokeWidth={1.6} strokeDasharray="4 3"
            strokeOpacity={0.7} connectNulls isAnimationActive={false}
            dot={({ key, ...p }) => <BoundDot key={key} {...p} payload={(p.payload as Row)?.prod_p} color={color} />}
            activeDot={{ r: 5, fill: color }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
