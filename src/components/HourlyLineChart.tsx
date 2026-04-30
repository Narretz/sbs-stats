import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";
import type { TooltipProps } from "recharts";
import type { DailyDaySeries } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import type { Theme } from "@/theme";
import { FONTS } from "@/theme";
export type TooltipSortMode = "date" | "value";

interface Props {
  title: string;
  data: DailyDaySeries[];
  globalMax: number;
  globalMedian: number;
  wfull: boolean;
  tooltipSort?: TooltipSortMode;
  highlight?: boolean;
  selectedDate?: string;
}
function pivotData(series: DailyDaySeries[]): Record<string, number | null>[] {
  // X-axis runs 0–24. Hour 0 is always 0 (day start anchor).
  // DB hours 0–23 are mapped to display positions 1–24.
  const rows: Record<string, number | null>[] = [];
  // Anchor at x=0, all series = 0
  const anchor: Record<string, number | null> = { hour: 0 };
  for (const s of series) anchor[s.date] = 0;
  rows.push(anchor);
  // DB hour N → display position N+1
  for (let h = 0; h < 24; h++) {
    const row: Record<string, number | null> = { hour: h + 1 };
    for (const s of series) {
      const pt = s.points.find((p) => p.hour === h);
      row[s.date] = pt != null ? pt.value : null;
    }
    rows.push(row);
  }
  return rows;
}
type TooltipEntry = { dataKey: string; value: number };

const CustomTooltip = ({
  active, payload, label, currentDate, t, sortMode,
}: TooltipProps<number, string> & {
  currentDate: string | undefined;
  t: Theme;
  sortMode: TooltipSortMode;
}) => {
  if (!active || !payload?.length) return null;

  const today = Temporal.Now.plainDateISO().toString();

  // Normalise Recharts payload to our simple shape, filtering out bad entries
  const entries: TooltipEntry[] = payload
    .filter((p) => typeof p.dataKey === "string" && typeof p.value === "number")
    .map((p) => ({ dataKey: p.dataKey as string, value: p.value as number }));

  // Sort by value (highest first) or by date (today first, then newest→oldest)
  const sorted = [...entries].sort((a, b) => {
    if (sortMode === "value") return (b.value ?? 0) - (a.value ?? 0);
    if (a.dataKey === currentDate) return -1;
    if (b.dataKey === currentDate) return 1;
    return b.dataKey.localeCompare(a.dataKey);
  });
  const hourMedian = sorted.length
    ? [...sorted].map((e) => e.value).sort((a, b) => a - b)[Math.floor(sorted.length / 2)]
    : 0;
  const currentEntry = currentDate ? sorted.find((e) => e.dataKey === currentDate) : undefined;
  const currentDeltaPct = currentEntry
    ? (hourMedian !== 0 ? ((currentEntry.value - hourMedian) / hourMedian) * 100 : null)
    : null;
  // Split into columns of max 10 rows each
  const ROWS_PER_COL = 10;
  const columns: typeof sorted[] = [];
  for (let i = 0; i < sorted.length; i += ROWS_PER_COL) {
    columns.push(sorted.slice(i, i + ROWS_PER_COL));
  }
  return (
    <div style={{
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: "8px 10px",
      fontFamily: FONTS.mono,
      fontSize: 11,
      boxShadow: "0 4px 20px rgba(0,0,0,0.22)",
      pointerEvents: "none",
      position: "relative",
      zIndex: 9999,
    }}>
      {/* Hour header */}
      <div style={{ color: t.textMuted, marginBottom: 5, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em" }}>
        {label == null ? "" : label === 0 ? "00:00" : `${String(label - 1).padStart(2,"0")}:00–${String(label - 1).padStart(2,"0")}:59`}
        {` · med ${hourMedian.toLocaleString()}`}
        {` · cur ${currentDeltaPct == null ? "n/a" : `${currentDeltaPct >= 0 ? "+" : ""}${currentDeltaPct.toFixed(1)}%`} vs med`}
      </div>
      {/* Columns */}
      <div style={{ display: "flex", gap: 12 }}>
        {columns.map((col, ci) => (
          <div key={ci}>
            {col.map((p) => {
              // Show MM-DD for past days to save space
              const [_y, m, d] = p.dataKey.split('-');

              const isToday = p.dataKey === today;

              const isCurrentDate = p.dataKey === currentDate;

              const highlight = isToday || isCurrentDate;

              const label = isToday ? "TODAY" : `${d}.${m}.`;

              return (
                <div key={p.dataKey} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 2,
                  color: highlight ? t.accent : t.textMuted,
                  fontWeight: highlight ? 700 : 400,
                  lineHeight: "15px",
                }}>
                  <span>{label}</span>
                  <span style={{ color: t.text, fontWeight: isToday ? 700 : 400 }}>
                    {p.value.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
// Inject CSS once to elevate hovered chart card above siblings
const STYLE_ID = "hourly-chart-hover-style";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `.hourly-card { position: relative; z-index: 1; } .hourly-card:hover { z-index: 100; }`;
  document.head.appendChild(s);
}
export function HourlyLineChart({ title, data, globalMax, globalMedian, wfull, tooltipSort = "date", highlight = false, selectedDate }: Props) {
  const { theme: t } = useTheme();
  const chartData = pivotData(data);
  const primarySeries = (highlight && data.length > 0)
    ? (data.find((s) => s.date === selectedDate) ?? data[data.length - 1])
    : data.find((s) => s.is_today);
  const pastSeries = data.filter((s) => s.date !== primarySeries?.date);
  const total = pastSeries.length;
  const getOpacity = (index: number) =>
    total <= 1 ? 0.18 : 0.07 + (index / (total - 1)) * 0.35;

  const isToday = !selectedDate || selectedDate === Temporal.Now.plainDateISO().toString();

  return (
    <div className="hourly-card" style={{
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
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: t.accent, fontWeight: 700 }}>{isToday ? 'TODAY' : selectedDate}</span>
        <span style={{ color: t.textMuted }}>{total} previous day{total !== 1 ? "s" : ""}</span>
        <span style={{ color: t.accent }}>▲ MAX {globalMax.toLocaleString()}</span>
        <span style={{ color: t.muted }}>~ MED {globalMedian.toLocaleString()}</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="hour"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            ticks={Array.from({ length: 25 }, (_, i) => i)}
            tickFormatter={(h: number) => `${h}`}
            type="number"
            domain={[0, 24]}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} domain={[0, (dataMax: number) => Math.max(dataMax, globalMax)]} />
          <Tooltip
            content={(props) => <CustomTooltip {...props} currentDate={primarySeries?.date} t={t} sortMode={tooltipSort} />}
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 9999 }}
          />
          <ReferenceLine y={globalMax} stroke={t.accent} strokeDasharray="4 4" strokeOpacity={0.6}
            label={{ value: "MAX", position: "insideTopRight", fontSize: 9, fill: t.accent, fontFamily: FONTS.mono }} />
          <ReferenceLine y={globalMedian} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
            label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
          {pastSeries.map((s, i) => (
            <Line key={s.date} type="monotone" dataKey={s.date}
              stroke="#9ca3af" strokeWidth={1} strokeOpacity={getOpacity(i)}
              dot={false} activeDot={{ r: 3, fill: "#9ca3af", opacity: 0.6 }}
              connectNulls isAnimationActive={false}
            />
          ))}
          {primarySeries && (
            <Line key={primarySeries.date} type="monotone" dataKey={primarySeries.date}
              stroke={t.accent} strokeWidth={3.5} strokeOpacity={1}
              dot={false} activeDot={{ r: 4, fill: t.accent }}
              connectNulls isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

