import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  ReferenceLine, ResponsiveContainer,
} from "recharts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DailyDaySeries, EodEstimate } from "@/types";
import { getKyivDateString } from "@/hooks/sqlLoader";
import { baselineOf, eodAtHour, hourBaseline, type HourHistory } from "@/utils/hourlyTooltip";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { maxMedian } from "@/utils/windowStats";
import type { Theme } from "@/theme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { chartAnchor } from "@/utils/chartAnchor";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { ChartPlaceholder, useNearViewport } from "@/components/LazyChartArea";
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
  // End-of-day estimates for today's (in-progress) series, one per reading so
  // far — the tooltip shows the one made at the hovered hour.
  eodSteps?: EodEstimate[] | null;
  // Every reading in the dataset per hour (0–23), for the tooltip's median /
  // max when the stats are scoped to all data — as the MAX/MED lines are. A
  // getter, so it is only built for a chart somebody hovers. Without it the
  // tooltip uses the window in both scopes.
  allHours?: () => Map<number, HourHistory>;
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
// Stable identity, so the memo below doesn't hand recharts a new empty array
// on every render of a chart that hasn't arrived yet.
const EMPTY_ROWS: HourRow[] = [];

function formatHour(hour: number | null | undefined): string {
  if (hour == null) return "";
  if (hour === 0) return "00:00";
  const h = String(hour - 1).padStart(2, "0");
  return `${h}:00–${h}:59`;
}

// The date grid: one row per day in the window, in as many columns as the
// available height allows.
//
// The columns are real sibling elements, chunked here, rather than a
// column-direction `flex-wrap`. The wrap reads better and needs no arithmetic,
// but a wrapping flex box reports its max-content width as a SINGLE column in
// Firefox (Chrome sums the lines), and the card is sized by exactly that
// measurement — so the card came out as wide as its header line, about three
// columns, and every column past the third hung outside its border. As a row
// of siblings the width is the sum by construction, in every engine.
//
// How many rows per column is a question about height, and neither renderer
// answers it on its own: the sheet hands the grid a definite height (it is a
// flex child of `.chart-sheet-body`) but more of it than the grid should take,
// while a floating tooltip is positioned rather than laid out and bounds
// nothing at all. So MAX_GRID_HEIGHT bounds both, and the grid re-chunks to
// the height it actually got — which converges in one layout pass, and follows
// a window resize or a rotation.
const LINE_H = 15;
const ROW_GAP = 4;
// The grid's shape, in one knob. Rows fill a column before a new one starts,
// so this is the height at which it gives up and goes wider: lower is shorter
// and wider, higher is taller and narrower. It binds in BOTH renderers — the
// sheet has more height to offer than the grid should take, and a grid that
// filled it left a column of narrow columns and a needlessly tall sheet.
//
// At 1440x900, for a 120-day window: 46vh/420 is 6 columns of 22 (576px wide),
// 34vh/300 is 8 of 16 (772px), 28vh/240 is 10 of 12 (968px), 22vh/190 is 12 of
// 10 and 1164px — past which the card is wider than most of the window it
// floats over.
const MAX_GRID_HEIGHT = "min(34vh, 300px)";
const MAX_GRID_HEIGHT_PX = (vh: number) => Math.min(vh * 0.34, 300);
// Rows that fit in `h` pixels: n lines plus the gaps BETWEEN them, so the
// inverse is (h + gap) / (line + gap) — not h / row, which reads one row short
// of what it just laid out and walks the column count down a row per pass.
const rowsIn = (h: number) => Math.max(1, Math.floor((h + ROW_GAP) / (LINE_H + ROW_GAP)));

function DateGrid({ children }: { children: React.ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [perColumn, setPerColumn] = useState(() =>
    rowsIn(MAX_GRID_HEIGHT_PX(window.innerHeight)));

  // Observed rather than measured once: the height this grid is given changes
  // under it — the window resizes, the sheet opens, a phone rotates.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setPerColumn((prev) => (prev === rowsIn(h) ? prev : rowsIn(h)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns: React.ReactNode[][] = [];
  for (let i = 0; i < children.length; i += perColumn) {
    columns.push(children.slice(i, i + perColumn));
  }
  return (
    <div
      ref={ref}
      data-testid="hourly-tooltip-days"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        // Claims the sheet body's leftover height; inert in the card, where the
        // parent is an ordinary block and the cap is the only bound.
        flex: "1 1 auto",
        minHeight: 0,
        maxHeight: MAX_GRID_HEIGHT,
      }}
    >
      {columns.map((col, ci) => (
        <div key={ci} style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>{col}</div>
      ))}
    </div>
  );
}

// This tooltip is a grid of dates, not a table of series, so it goes through
// the descriptor's `content` escape hatch: as a single column it would be one
// row per day in the window — thirty rows tall on a 30-day view.
//
// Entries come from the pivoted row rather than recharts' tooltip payload,
// which is what lets the pinned sheet render the identical grid.
function describeHour({
  row, dates, currentDate, today, t, sortMode, eod, allHours,
}: {
  row: HourRow;
  dates: string[];
  currentDate: string | undefined;
  today: string;
  t: Theme;
  sortMode: TooltipSortMode;
  eod: EodEstimate | null;
  allHours: (() => Map<number, HourHistory>) | null;
}): TooltipDescriptor {
  const label = row.hour;

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
  const currentEntry = currentDate ? sorted.find((e) => e.dataKey === currentDate) : undefined;
  // Row 0 is the day-start anchor every day is pinned to, not a reading.
  const base = label === 0
    ? null
    : allHours
      ? baselineOf(allHours().get(label - 1), currentDate, currentEntry?.value)
      : hourBaseline(sorted.map((e) => ({ date: e.dataKey, value: e.value })), currentDate);

  const multipleYears = new Set(sorted.map(p => p.dataKey.slice(0, 4))).size > 1;
  const dayLabel = (date: string) => {
    const [y, m, d] = date.split("-");
    return multipleYears ? `${y}-${m}-${d}` : `${m}-${d}`;
  };
  // Under "All data" the max can come from a day outside the window, and so
  // from a year the window doesn't show.
  const maxDayLabel = (date: string) =>
    date.slice(0, 4) !== (currentDate ?? today).slice(0, 4) ? date : dayLabel(date);

  const header = (
    <div style={{marginBottom: 4}}>
      <div style={{ color: t.accent, marginBottom: 5, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em" }}>
        {currentDate === today ? 'TODAY' : currentDate} {formatHour(label)}: {currentEntry ? currentEntry.value.toLocaleString() : 'n/a'}{eod && `, EoD est ~${eod.projected.toLocaleString()} (${Math.round(eod.fraction * 100)}% in by ${eod.asOf})`}
      </div>
      {base == null ? null : base.days > 0 ? (
        <div>
          {`median ${base.median!.toLocaleString()}` }
          {` · current ${base.deltaPct == null ? "n/a" : `${base.deltaPct >= 0 ? "+" : ""}${base.deltaPct.toFixed(1)}%`} vs median`}
          {`· max ${base.max!.toLocaleString()} (${maxDayLabel(base.maxDate!)})`}
          {` of ${base.days} other ${base.days === 1 ? "day" : "days"}`}
        </div>
      ) : (
        <div>no other day has a value at this hour</div>
      )}
    </div>
  );

  const content = (
    <>
      <DateGrid>
        {sorted.map((p) => {
          // Show MM-DD for past days to save space — with the year in front of
          // it only when the window spans more than one, where MM-DD alone
          // would put two different days under the same label.
          const isToday = p.dataKey === today;

          const isCurrentDate = p.dataKey === currentDate;

          const highlight = isToday || isCurrentDate;

          const label = isToday ? "TODAY" : dayLabel(p.dataKey);

          return (
            <div key={p.dataKey} style={{
              display: "flex",
              gap: 8,
              justifyContent: 'space-between',
              color: highlight ? t.accent : t.textMuted,
              fontWeight: highlight ? 700 : 400,
              lineHeight: `${LINE_H}px`,
            }}>
              <span>{label}</span>
              <span style={{ color: highlight ? t.accent : t.text, fontWeight: highlight ? 700 : 400 }}>
                {p.value.toLocaleString()}
              </span>
            </div>
          );
        })}
      </DateGrid>
    </>
  );
  return { header, rows: [], content, minWidth: 200 };
}
export function HourlyLineChart({ title, data, globalMax, globalMedian, globalTotal, wfull, tooltipSort = "date", highlight = false, selectedDate, eodSteps, allHours, pairedData, pairedGlobalMax }: Props) {
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
  // The plot area, and the pivot that feeds it, both wait until the card is
  // nearly in view — see LazyChartArea. Memoised as well as deferred: `data`
  // only changes when the page re-queries, while this component re-renders on
  // every hover, and the pivot walks every day in the window.
  const plotRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(plotRef);
  const chartData = useMemo(
    () => (near ? (pivotData(data) as HourRow[]) : EMPTY_ROWS),
    [near, data],
  );
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

  // Kyiv's date, like every query behind these charts — the browser's own
  // date disagrees with it for hours a day anywhere west or east of Kyiv.
  const today = getKyivDateString();
  const isToday = !selectedDate || selectedDate === today;
  const todaySeries = isToday ? data.find((s) => s.date === today) : undefined;

  const dates = data.map((s) => s.date);
  const anchor = chartAnchor(title);
  const pin = usePinnedChart({
    chartId: anchor || title,
    title,
    data: chartData,
    xOf: (r) => r.hour,
    describe: (row) => describeHour({
      row, dates, currentDate: primarySeries?.date, today, t,
      sortMode: tooltipSort,
      allHours: win ? null : (allHours ?? null),
      // Row 0 is the chart's day-start anchor, not a reading.
      eod: row.hour > 0 ? eodAtHour(eodSteps, todaySeries, row.hour - 1) : null,
    }),
    formatLabel: (r) => formatHour(r.hour),
    // The date grid is as wide as its column count, which a half-width chart
    // is not: without this the columns hang out past the card's border.
    fitToContent: true,
  });

  return (
    <div className="hourly-card" id={anchor || undefined} {...pin.cardProps} style={{
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: wfull ? "1 / -1" : undefined,
      animation: "fadeIn 0.3s ease both",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      cursor: "pointer",
    }}>
      <ChartCardTitle title={title} anchor={anchor} marginBottom={4} />
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: c.maxReference }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: c.medReference }}>~ MED {median.toLocaleString()}</span>
        <span style={{ color: t.textMuted }}>Σ TOTAL {windowTotal.toLocaleString()}</span>
      </div>
{near ? (
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
      ) : (
        <ChartPlaceholder inner={plotRef} height={220} />
      )}
      {pin.sheet}
    </div>
  );
}

