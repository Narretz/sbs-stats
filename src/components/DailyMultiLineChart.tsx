import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, type DotProps,
} from "recharts";
import { useMemo } from "react";
import type { DailyDataPoint } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { FONTS, type Theme } from "@/theme";

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  data: DailyDataPoint[];
  // Whole-dataset max/median/total for this series; used when the scope is
  // "all". Without them the chart falls back to window stats either way.
  globalMax?: number;
  globalMedian?: number;
  globalTotal?: number;
}

export type YAxisMode = "linear" | "log" | "normalized";

export type ChartGranularity = "daily" | "monthly";

interface Props {
  title: string;
  series: LineSeries[];
  wfull?: boolean;
  // Y-axis transform. "linear" (default) plots raw values; "log" uses a base-10
  // log scale (skips zeros / nulls); "normalized" scales each series to [0, 1]
  // by its own visible max so shape is comparable across magnitudes.
  yMode?: YAxisMode;
  // Hint that the values being plotted are running cumulative sums (so the
  // legend collapses to just Σ — MAX and MED of a monotonic series aren't
  // informative). The transform itself happens upstream; this only affects
  // how the legend is rendered.
  cumulative?: boolean;
  // X-axis grain. "daily" expects YYYY-MM-DD `date` keys; "monthly" expects
  // YYYY-MM and switches the tick + tooltip formatters accordingly. Both modes
  // share the same `DailyDataPoint` shape — only the date string differs.
  granularity?: ChartGranularity;
}

type Row = { date: string; is_today: boolean } & Record<string, number | null | string | boolean>;

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}
function formatDate(v: string): string {
  const [y, m, d] = v.split("-");
  return `${d}.${m}.${y}`;
}
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatMonth(v: string): string {
  const [y, m] = v.split("-");
  const idx = Number(m) - 1;
  return `${MONTH_NAMES[idx] ?? m} ${y}`;
}
function formatMonthTick(v: string): string {
  const [y, m] = v.split("-");
  const idx = Number(m) - 1;
  return `${MONTH_NAMES[idx] ?? m} ${y.slice(2)}`;
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
  active, payload, t, series, granularity,
}: {
  active?: boolean;
  payload?: { payload?: Row }[];
  t: Theme;
  series: LineSeries[];
  granularity: ChartGranularity;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const row = payload[0].payload;
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 6,
      padding: "8px 10px", fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)", minWidth: 170,
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>
        {granularity === "monthly" ? formatMonth(row.date) : formatDate(row.date)}
      </div>
      {series.map((s) => {
        // Always show raw absolute values in the tooltip — even in normalized
        // mode, the user wants to know "what is the actual number today?"
        const raw = row[`${s.key}__raw`];
        return (
          <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: s.color }}>
            <span>{s.label}</span><span>{fmt(raw as number | null)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function DailyMultiLineChart({ title, series, wfull = false, yMode = "linear", cumulative = false, granularity = "daily" }: Props) {
  const { theme: t } = useTheme();
  const { scope } = useStatScope();
  const allScope = scope === "all";

  const { rows, max } = useMemo(() => {
    // Per-series window max — used to normalize each series to [0, 1] when
    // yMode === "normalized". Zero-max series stay at 0 (no division-by-zero).
    const perSeriesMax = new Map<string, number>();
    for (const s of series) {
      let m = 0;
      for (const p of s.data) if (typeof p.value === "number" && p.value > m) m = p.value;
      perSeriesMax.set(s.key, m);
    }
    const byDate = new Map<string, Row>();
    for (const s of series) {
      const sMax = perSeriesMax.get(s.key) ?? 0;
      for (const p of s.data) {
        const r = byDate.get(p.date) ?? ({ date: p.date, is_today: p.is_today } as Row);
        // Raw absolute value preserved for the tooltip regardless of yMode.
        r[`${s.key}__raw`] = p.value;
        // Plotted value depends on mode. For "log" we drop zeros / nulls (log
        // is undefined there) and let recharts skip — `connectNulls` keeps the
        // line continuous around the gap.
        let plotted: number | null = p.value;
        if (yMode === "normalized") {
          plotted = typeof p.value === "number" && sMax > 0 ? p.value / sMax : null;
        } else if (yMode === "log") {
          plotted = typeof p.value === "number" && p.value > 0 ? p.value : null;
        }
        r[s.key] = plotted;
        if (p.is_today) r.is_today = true;
        byDate.set(p.date, r);
      }
    }
    const rows = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    let max = 0;
    for (const s of series)
      for (const p of s.data) if (typeof p.value === "number" && p.value > max) max = p.value;
    return { rows, max };
  }, [series, yMode]);

  const legendStat = (s: LineSeries) => {
    const vals = s.data.map((p) => p.value).filter((v): v is number => typeof v === "number");
    // In cumulative mode the upstream has already replaced each point's value
    // with the running sum, so Σ is the final non-null point — not the sum
    // of cumulative values, which would be triangular and meaningless.
    if (cumulative) {
      return { max: 0, med: 0, total: vals.length ? vals[vals.length - 1] : 0 };
    }
    const windowTotal = vals.reduce((acc, n) => acc + n, 0);
    if (allScope && typeof s.globalMax === "number")
      return { max: s.globalMax, med: s.globalMedian ?? 0, total: s.globalTotal ?? 0 };
    return { max: vals.length ? Math.max(...vals) : 0, med: median(vals), total: windowTotal };
  };

  // In "all" scope, lift the y-axis ceiling to the largest series global max so
  // this chart shares the main daily chart's scale; in "window" it fits the
  // data. Only relevant for "linear" — "log" lets recharts auto-fit on a base-10
  // ladder, and "normalized" is locked to [0, 1]. In cumulative mode the
  // globalMax represents a daily peak, not a cumulative one, so we always
  // fit to the visible data.
  const ceiling = (!cumulative && allScope)
    ? Math.max(max, ...series.map((s) => s.globalMax ?? 0))
    : max;

  return (
    <div className="chart-card" style={{
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
              ● {s.label}{" "}
              {cumulative ? (
                <span style={{ opacity: 0.8 }}>· Σ {st.total.toLocaleString()}</span>
              ) : (
                <span style={{ opacity: 0.8 }}>· MAX {st.max.toLocaleString()} · MED {st.med.toLocaleString()} · Σ {st.total.toLocaleString()}</span>
              )}
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
            tickFormatter={granularity === "monthly"
              ? formatMonthTick
              : (v: string) => { const p = v.slice(5).split("-"); return `${p[1]}/${p[0]}`; }}
          />
          {yMode === "log" ? (
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              scale="log"
              domain={["auto", "auto"]}
              allowDataOverflow
            />
          ) : yMode === "normalized" ? (
            <YAxis
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              domain={[0, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            />
          ) : (
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax, ceiling)]}
            />
          )}
          <Tooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 9999 }}
            cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
            content={(props) => (
              <MultiTooltip active={props.active} payload={props.payload as { payload?: Row }[] | undefined} t={t} series={series} granularity={granularity} />
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
