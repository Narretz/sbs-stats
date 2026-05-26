import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, type DotProps,
} from "recharts";
import { useMemo } from "react";
import type { DailyDataPoint } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { FONTS, type Theme } from "@/theme";

// Reuse the hover-elevation class injected by DailyLineChart so an overflowing
// tooltip isn't clipped under the next card. Guarded — no-op if already present.
const STYLE_ID = "daily-chart-hover-style";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `.daily-card { position: relative; z-index: 1; } .daily-card:hover { z-index: 100; }`;
  document.head.appendChild(s);
}

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  data: DailyDataPoint[];
  // Whole-dataset max/median for this series; used when the MAX/MED scope is
  // "all". Without them the chart falls back to window stats either way.
  globalMax?: number;
  globalMedian?: number;
}

interface Props {
  title: string;
  series: LineSeries[];
  wfull?: boolean;
}

type Row = { date: string; is_today: boolean } & Record<string, number | null | string | boolean>;

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}
function formatDate(v: string): string {
  const [y, m, d] = v.split("-");
  return `${d}.${m}.${y}`;
}
function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function Dot(props: DotProps & { payload?: Row; color: string; bg: string }) {
  const { cx, cy, payload, color, bg } = props;
  if (cx == null || cy == null) return null;
  if (payload?.is_today) return <circle cx={cx} cy={cy} r={5} fill={color} stroke={bg} strokeWidth={2} />;
  return <circle cx={cx} cy={cy} r={2} fill={color} opacity={0.5} />;
}

function MultiTooltip({
  active, payload, t, series,
}: {
  active?: boolean;
  payload?: { payload?: Row }[];
  t: Theme;
  series: LineSeries[];
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const row = payload[0].payload;
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 6,
      padding: "8px 10px", fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)", minWidth: 170,
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>{formatDate(row.date)}</div>
      {series.map((s) => (
        <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: s.color }}>
          <span>{s.label}</span><span>{fmt(row[s.key] as number | null)}</span>
        </div>
      ))}
    </div>
  );
}

export function DailyMultiLineChart({ title, series, wfull = false }: Props) {
  const { theme: t } = useTheme();
  const { scope } = useStatScope();
  const allScope = scope === "all";

  const { rows, max } = useMemo(() => {
    const byDate = new Map<string, Row>();
    for (const s of series) {
      for (const p of s.data) {
        const r = byDate.get(p.date) ?? ({ date: p.date, is_today: p.is_today } as Row);
        r[s.key] = p.value;
        if (p.is_today) r.is_today = true;
        byDate.set(p.date, r);
      }
    }
    const rows = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    let max = 0;
    for (const s of series)
      for (const p of s.data) if (typeof p.value === "number" && p.value > max) max = p.value;
    return { rows, max };
  }, [series]);

  const legendStat = (s: LineSeries) => {
    if (allScope && typeof s.globalMax === "number")
      return { max: s.globalMax, med: s.globalMedian ?? 0 };
    const vals = s.data.map((p) => p.value).filter((v): v is number => typeof v === "number");
    return { max: vals.length ? Math.max(...vals) : 0, med: median(vals) };
  };

  // In "all" scope, lift the y-axis ceiling to the largest series global max so
  // this chart shares the main daily chart's scale; in "window" it fits the data.
  const ceiling = allScope
    ? Math.max(max, ...series.map((s) => s.globalMax ?? 0))
    : max;

  return (
    <div className="daily-card" style={{
      background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
      padding: "18px 16px 12px", gridColumn: wfull ? "1 / -1" : undefined,
      animation: "fadeIn 0.3s ease both", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        {series.map((s) => {
          const st = legendStat(s);
          return (
            <span key={s.key} style={{ color: s.color }}>
              ● {s.label} <span style={{ opacity: 0.8 }}>· MAX {st.max.toLocaleString()} · MED {st.med.toLocaleString()}</span>
            </span>
          );
        })}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: string) => { const p = v.slice(5).split("-"); return `${p[1]}/${p[0]}`; }}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
            domain={[0, (dataMax: number) => Math.max(dataMax, ceiling)]} />
          <Tooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 9999 }}
            cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
            content={(props) => (
              <MultiTooltip active={props.active} payload={props.payload as { payload?: Row }[] | undefined} t={t} series={series} />
            )}
          />
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
              dot={({ key, ...props }) => <Dot key={key} {...props} color={s.color} bg={t.surface} />}
              activeDot={{ r: 5, fill: s.color }} connectNulls isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
