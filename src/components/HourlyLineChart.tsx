import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  ReferenceLine, ResponsiveContainer,
} from "recharts";
import { Temporal } from "temporal-polyfill";
import { useMemo } from "react";
import type { DailyDaySeries, EodEstimate } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { maxMedian } from "@/utils/windowStats";
import type { Theme } from "@/theme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { chartAnchor } from "@/utils/chartAnchor";
import { usePinnedChart } from "@/components/usePinnedChart";
import type { TooltipDescriptor } from "@/components/TooltipTable";
export type TooltipSortMode = "date" | "value";

interface Props {
  title: string;
  data: DailyDaySeries[];
  globalMax: number;
  globalMedian: number;
  globalTotal?: number;
  wfull: boolean;
  tooltipSort?: TooltipSortMode;
  highlight?: boolean;
  selectedDate?: string;
  // End-of-day estimate for today's (in-progress) series.
  eod?: EodEstimate | null;
  // Optional sibling data used to extend the Y-axis upper bound so paired
  // charts (e.g. destroyed alongside hit) share a visual scale. The chart's
  // own MAX/MED labels and reference lines are unaffected.
  pairedData?: DailyDaySeries[];
  pairedGlobalMax?: number;
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
type HourRow = { hour: number } & Record<string, number | null>;

function formatHour(hour: number | null | undefined): string {
  if (hour == null) return "";
  if (hour === 0) return "00:00";
  const h = String(hour - 1).padStart(2, "0");
  return `${h}:00–${h}:59`;
}

// This tooltip is a grid of dates, not a table of series, so it goes through
// the descriptor's `content` escape hatch: as a single column it would be one
// row per day in the window — thirty rows tall on a 30-day view.
//
// Entries come from the pivoted row rather than recharts' tooltip payload,
// which is what lets the pinned sheet render the identical grid.
function describeHour({
  row, dates, currentDate, t, sortMode, eod,
}: {
  row: HourRow;
  dates: string[];
  currentDate: string | undefined;
  t: Theme;
  sortMode: TooltipSortMode;
  eod: EodEstimate | null;
}): TooltipDescriptor {
  const label = row.hour;
  const today = Temporal.Now.plainDateISO().toString();

  const entries: TooltipEntry[] = dates
    .map((date) => ({ dataKey: date, value: row[date] }))
    .filter((e): e is TooltipEntry => typeof e.value === "number");

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
  const content = (
    <>
      {eod && (
        <div style={{ color: t.accent, marginBottom: 5, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em" }}>
          {`TODAY EoD est ~${eod.projected.toLocaleString()} (${Math.round(eod.fraction * 100)}% in by ${eod.asOf})`}
        </div>
      )}
      {/* Columns */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {columns.map((col, ci) => (
          <div key={ci}>
            {col.map((p) => {
              // Show MM-DD for past days to save space
              const [, m, d] = p.dataKey.split('-');

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
                  color: highlight ? chartColors(t).hourlyToday : t.textMuted,
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
    </>
  );
  const header = (
    <>
      {formatHour(label)}
      {` · med ${hourMedian.toLocaleString()}`}
      {` · cur ${currentDeltaPct == null ? "n/a" : `${currentDeltaPct >= 0 ? "+" : ""}${currentDeltaPct.toFixed(1)}%`} vs med`}
    </>
  );
  return { header, rows: [], content, minWidth: 200 };
}
export function HourlyLineChart({ title, data, globalMax, globalMedian, globalTotal, wfull, tooltipSort = "date", highlight = false, selectedDate, eod, pairedData, pairedGlobalMax }: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const { scope } = useStatScope();
  // "window" scopes MAX/MED to the days currently shown. Each day's value is its
  // end-of-day total (max of its cumulative intraday points).
  const win = scope === "window";
  const dayEodValues = (series: DailyDaySeries[]) =>
    series.map((s) => {
      const vals = s.points.map((p) => p.value).filter((v): v is number => typeof v === "number");
      return vals.length ? Math.max(...vals) : null;
    });
  const winStat = useMemo(() => maxMedian(dayEodValues(data)), [data]);
  const pairedWinMax = useMemo(
    () => (pairedData ? maxMedian(dayEodValues(pairedData)).max : 0),
    [pairedData]
  );
  const max = win ? winStat.max : globalMax;
  const median = win ? winStat.median : globalMedian;
  const windowTotal = win ? winStat.total : (globalTotal ?? 0);
  // Y-axis upper bound: own scale, but lifted to a paired sibling's scale when
  // provided so e.g. a destroyed chart shares its hit counterpart's scale.
  const yScaleMax = win
    ? Math.max(max, pairedWinMax)
    : Math.max(max, pairedGlobalMax ?? 0);
  const chartData = pivotData(data) as HourRow[];
  // When a date is selected, highlight only the series for that exact date.
  // No fallback to the most-recent day: selecting a date with no data (e.g. a
  // day whose report hasn't landed) must not emphasise a different day.
  const primarySeries = (highlight && data.length > 0)
    ? data.find((s) => s.date === selectedDate)
    : data.find((s) => s.is_today);
  const pastSeries = data.filter((s) => s.date !== primarySeries?.date);
  const total = pastSeries.length;
  const getOpacity = (index: number) =>
    total <= 1 ? 0.18 : 0.07 + (index / (total - 1)) * 0.35;

  const isToday = !selectedDate || selectedDate === Temporal.Now.plainDateISO().toString();

  const dates = data.map((s) => s.date);
  const pin = usePinnedChart({
    chartId: chartAnchor(title) || title,
    title,
    data: chartData,
    xOf: (r) => r.hour,
    describe: (row) => describeHour({
      row, dates, currentDate: primarySeries?.date, t,
      sortMode: tooltipSort, eod: isToday ? (eod ?? null) : null,
    }),
    formatLabel: (r) => formatHour(r.hour),
  });

  return (
    <div className="hourly-card" {...pin.cardProps} style={{
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: wfull ? "1 / -1" : undefined,
      animation: "fadeIn 0.3s ease both",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      cursor: "pointer",
    }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: c.maxReference }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: c.medReference }}>~ MED {median.toLocaleString()}</span>
        <span style={{ color: t.textMuted }}>Σ TOTAL {windowTotal.toLocaleString()}</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }} {...pin.chartProps}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="hour"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            ticks={Array.from({ length: 25 }, (_, i) => i)}
            tickFormatter={(h: number) => `${h}`}
            type="number"
            domain={[0, 24]}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} domain={[0, (dataMax: number) => Math.max(dataMax, yScaleMax)]} />
          {pin.tooltip}
          <ReferenceLine y={max} stroke={c.maxReference} strokeDasharray="4 4" strokeOpacity={0.6}
            label={{ value: "MAX", position: "insideTopRight", fontSize: 9, fill: c.maxReference, fontFamily: FONTS.mono }} />
          <ReferenceLine y={median} stroke={c.medReference} strokeDasharray="4 4" strokeOpacity={0.5}
            label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: c.medReference, fontFamily: FONTS.mono }} />
          {pastSeries.map((s, i) => (
            <Line key={s.date} type="monotone" dataKey={s.date}
              stroke={c.hourlyPastDay} strokeWidth={1} strokeOpacity={getOpacity(i)}
              dot={false} activeDot={{ r: 3, fill: c.hourlyPastDay, opacity: 0.6 }}
              connectNulls isAnimationActive={false}
            />
          ))}
          {primarySeries && (
            <Line key={primarySeries.date} type="monotone" dataKey={primarySeries.date}
              stroke={c.hourlyToday} strokeWidth={3.5} strokeOpacity={1}
              dot={false} activeDot={{ r: 4, fill: c.hourlyToday }}
              connectNulls isAnimationActive={false}
            />
          )}
          {/* Painted last so it reads as a crosshair over the series,
              not a stub buried under a bar. */}
          {pin.cursor}
        </LineChart>
      </ResponsiveContainer>
      {pin.sheet}
    </div>
  );
}

