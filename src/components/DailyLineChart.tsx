import {
  LineChart, Line, ComposedChart, Area, XAxis, YAxis, CartesianGrid,
  ReferenceLine, ResponsiveContainer, type DotProps,
} from "recharts";
import { useCallback, useMemo, type ReactNode } from "react";
import type { DailyDataPoint, EodEstimate, ModelBreakdownEntry, PairMode } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { usePinnedChart } from "@/components/usePinnedChart";
import { maxMedian } from "@/utils/windowStats";
import { FONTS, type Theme } from "@/theme";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { chartAnchor } from "@/utils/chartAnchor";
import { AREA_FILL_OPACITY, chartColors } from "@/chartColors";
import { breakdownToRows, type TooltipDescriptor, type TooltipTableRow } from "@/components/TooltipTable";

function linearRegression(data: DailyDataPoint[]): Array<number | null> {
  const points = data
    .map((d, i) => ({ x: i, y: d.value }))
    .filter((p): p is { x: number; y: number } => typeof p.y === "number");
  const n = points.length;
  if (n < 2) return data.map(d => d.value);
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return data.map((d, i) =>
    d.value == null ? null : Math.max(0, Math.round(slope * i + intercept))
  );
}

interface Props {
  title: string;
  data: DailyDataPoint[];
  globalMax: number;
  globalMedian: number;
  globalTotal?: number;
  wfull: boolean;
  data2?: DailyDataPoint[];
  primaryLabel?: string;
  label2?: string;
  globalMax2?: number;
  globalMedian2?: number;
  globalTotal2?: number;
  pairMode?: PairMode;
  // End-of-day estimate for the "today" point (primary / paired series).
  eod?: EodEstimate | null;
  eod2?: EodEstimate | null;
  // Optional per-date model breakdown rendered as continuation rows below
  // the main tooltip table. Used by the RU air-attacks daily category charts
  // to show "what models drove this day's number" (and by the aggregate "All"
  // chart to break the total into drone / cruise / ballistic categories).
  breakdownByDate?: Map<string, ModelBreakdownEntry[]>;
  // Subset-mode only: interpret `primaryLabel` as the label of the *difference*
  // (data − data2) rather than as the total. When true, the tooltip renders an
  // extra explicit "Total" row and shows the diff — not the raw `value` — under
  // the primary label. Used on the GSUA combat-engagements chart where the two
  // stacked areas are "With direction" (subset) and "Unattributed" (diff), so
  // calling the total "Unattributed" (default subset-mode behaviour) would be
  // wrong. Leaves the SBS-style hit/destroyed tooltips unchanged (they use
  // `primaryLabel="Hit"`, which IS the total, so no diff row is needed).
  primaryIsDiff?: boolean;
  /** Vocabulary for the subset absolute + subset rate columns (e.g. `Dest`
   *  on hit/destroyed pairs, `Int` on launched/intercepted, `Killed` on
   *  Personnel). TooltipTable renders `<label>` for the count and
   *  `<label> %` for the derived rate. Undefined on non-subset charts. */
  subsetLabel?: string;
}

function CustomDot(props: DotProps & {
  payload?: PairedRow;
  accentColor: string; primaryColor: string; bgColor: string; noteColor: string;
  pinnedDate?: string | null;
}) {
  const { cx, cy, payload, accentColor, primaryColor, bgColor, noteColor, pinnedDate } = props;
  if (cx == null || cy == null) return null;
  // The pinned point outranks every other dot state: it's the one the sheet is
  // currently describing, and it has to stay legible with the pointer nowhere
  // near the chart.
  if (pinnedDate && payload?.date === pinnedDate)
    return <circle cx={cx} cy={cy} r={6} fill={accentColor} stroke={bgColor} strokeWidth={2.5} />;
  if (payload?.is_today)
    return <circle cx={cx} cy={cy} r={5} fill={accentColor} stroke={bgColor} strokeWidth={2} />;
  if (payload?.note)
    return <circle cx={cx} cy={cy} r={4} fill={noteColor} stroke={bgColor} strokeWidth={1.5} />;
  return <circle cx={cx} cy={cy} r={2} fill={primaryColor} opacity={0.5} />;
}

type PairedRow = {
  date: string;
  value: number | null;
  value2: number | null;
  valueDiff: number | null;
  trend1: number | null;
  trend2: number | null;
  // Trend over the diff (v − v2) series. Only populated in subset mode when
  // the top area represents a computed difference rather than a raw series;
  // the paired tooltip surfaces it as "Trend (primaryLabel)" instead of
  // trend1 (which is the trend of the *total*, not the diff).
  trendDiff: number | null;
  is_today: boolean;
  eod: EodEstimate | null;
  eod2: EodEstimate | null;
  note?: string;
};

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function formatDate(v: string): string {
  const [y, m, d] = v.split("-");
  return `${d}.${m}.${y}`;
}

// Format an EoD estimate as a single cell node — the value/subset cell
// carries the projected total with the historical completion fraction
// (the share of the day's eventual total typically already reported by
// this hour). Percentage doubles as a confidence indicator; rendered
// smaller so the projected total stays the primary read.
function fmtEod(e: EodEstimate): ReactNode {
  return (
    <>
      <span style={{ fontSize: "0.917em" }}>~{fmt(e.projected)}</span><span style={{ fontSize: "0.833em", opacity: 0.9 }}> ({Math.round(e.fraction * 100)}%)</span>
    </>
  );
}

// Prose-only footer: the warning note lives below the TooltipTable, not
// inside its row grid. EoD estimates used to live here too but moved into
// the table so their projected + fraction align with the actual columns.
function noteFooter(note: string | undefined, t: Theme): ReactNode {
  if (!note) return null;
  return (
    <div className="tooltip-note" style={{ color: chartColors(t).noteText, fontSize: "0.833em", marginTop: 6, whiteSpace: "pre-line" }}>
      ⚠ {note}
    </div>
  );
}

// Everything the two describe* functions need that isn't the row itself.
interface DescribeCtx {
  t: Theme;
  primaryColor: string;
  primaryLabel: string;
  secondaryLabel: string;
  pairMode: PairMode;
  primaryIsDiff: boolean;
  breakdownByDate?: Map<string, ModelBreakdownEntry[]>;
  subsetLabel?: string;
  noteByDate: Map<string, string>;
}

// A date where every series is null — no data at all, or counts upstream
// withheld. Recharts drops null points from the tooltip payload, so this used
// to render as an empty tooltip and leave the gap in the line unexplained.
//
// The two renderers diverge here on purpose: `footer` (the note) shows on
// hover, but `emptyState` is sheet-only. A reader who pinned this date asked
// for it and needs to be told the gap isn't a zero; a hover tooltip that pops
// up "No data reported" over every gap is noise nobody asked for.
function describeGap(ctx: DescribeCtx, date: string): TooltipDescriptor {
  return {
    header: formatDate(date),
    rows: [],
    footer: noteFooter(ctx.noteByDate.get(date), ctx.t),
    minWidth: 180,
    emptyState: "No data reported for this date.",
  };
}

function describeSingle(ctx: DescribeCtx, d: PairedRow): TooltipDescriptor {
  const { t, primaryColor, primaryLabel, breakdownByDate, subsetLabel } = ctx;
  const entries = breakdownByDate?.get(d.date) ?? [];
  const rows: TooltipTableRow[] = [
    { label: primaryLabel, color: primaryColor, value: d.value, trend: d.trend1 },
  ];
  if (d.is_today && d.eod) {
    rows.push({ label: "EoD est", color: t.textMuted, value: fmtEod(d.eod) });
  }
  rows.push(...breakdownToRows(entries, t.textMuted, { totalForShare: typeof d.value === "number" ? d.value : undefined }));
  return {
    header: formatDate(d.date),
    rows,
    footer: noteFooter(d.note, t),
    subsetLabel,
    minWidth: 180,
  };
}

function describePaired(ctx: DescribeCtx, d: PairedRow): TooltipDescriptor {
  const {
    t, primaryColor, primaryLabel, secondaryLabel, pairMode, primaryIsDiff,
    breakdownByDate, subsetLabel,
  } = ctx;
  const v = d.value;
  const v2 = d.value2;
  const tr1 = d.trend1;
  const tr2 = d.trend2;
  const trDiff = d.trendDiff;
  const total = pairMode === "subset"
    ? v
    : (typeof v === "number" && typeof v2 === "number" ? v + v2 : null);
  // When primary is the diff, its displayed value is (v − v2), not v itself,
  // and its trend is `trendDiff` (regression over the diffs) rather than
  // `trend1` (which is the regression over the total — surfaced separately
  // as a Total row below).
  const primaryDisplayValue = pairMode === "subset" && primaryIsDiff
    ? (typeof v === "number" && typeof v2 === "number" ? v - v2 : null)
    : v;
  const primaryTrend = pairMode === "subset" && primaryIsDiff ? trDiff : tr1;
  // Per-component % (fair-share of the total). Solo pair-mode primary (SBS
  // "Hit") is the total itself → no % on it; component rows get pct.
  const totNum = typeof total === "number" ? total : null;
  const pctOf = (val: number | null): number | null =>
    val != null && totNum != null && totNum > 0 ? (val / totNum) * 100 : null;
  const showTotalRow = pairMode === "sum" || (pairMode === "subset" && primaryIsDiff);
  const entries = breakdownByDate?.get(d.date) ?? [];

  // When the chart is a hit/destroyed or launched/intercepted pair (signal:
  // `subsetLabel` is set) AND we're in the classic subset-primary-is-total
  // mode, roll up the two aggregate rows into one. The standalone
  // "Intercepted" / "Destroyed" row becomes redundant with the Subset
  // column that breakdown rows already populate. Combat Engagements
  // (primaryIsDiff=true) doesn't have a subsetLabel and keeps its Total /
  // Unattributed / With direction three-row structure.
  //
  // Cost of the collapse: the secondary trend (tr2) has no place on a
  // single row (the Trend column can only hold one value). The primary
  // trend is what most viewers care about on these charts, so tr2 is
  // dropped. Uncollapsed callers keep both trends.
  const useCollapsedSubset =
    pairMode === "subset" && !primaryIsDiff && subsetLabel !== undefined;

  const rows: TooltipTableRow[] = [];
  if (showTotalRow) {
    rows.push({ label: "Total", color: t.text, value: total, trend: tr1, emphasis: "bold" });
  }
  if (useCollapsedSubset) {
    // Rate = v2/v is derived by TooltipTable from `subset/value`.
    rows.push({
      label: primaryLabel, color: primaryColor,
      value: v,
      subset: v2,
      trend: tr1,
    });
  } else {
    rows.push({
      label: primaryLabel, color: primaryColor,
      value: primaryDisplayValue,
      share: showTotalRow ? pctOf(typeof primaryDisplayValue === "number" ? primaryDisplayValue : null) : null,
      trend: primaryTrend,
    });
    rows.push({
      label: secondaryLabel, color: chartColors(t).lineSecondary,
      value: v2,
      share: pctOf(typeof v2 === "number" ? v2 : null),
      trend: tr2,
    });
  }
  // On collapsed subset (hit/destroyed etc.), fold both EoDs into one row
  // where value = primary EoD, subset = secondary EoD (mirroring the
  // actual row above). Uncollapsed callers get one EoD row per series in
  // the Value column since the subset column doesn't apply to them.
  if (d.is_today && (d.eod || d.eod2)) {
    if (useCollapsedSubset) {
      rows.push({
        label: "EoD est", color: t.textMuted,
        value: d.eod ? fmtEod(d.eod) : null,
        subset: d.eod2 ? fmtEod(d.eod2) : null,
      });
    } else {
      if (d.eod) rows.push({ label: `${primaryLabel} · EoD est`, color: t.textMuted, value: fmtEod(d.eod) });
      if (d.eod2) rows.push({ label: `${secondaryLabel} · EoD est`, color: t.textMuted, value: fmtEod(d.eod2) });
    }
  }
  // The primary aggregate `v` (category-launched on RU air-attacks pairs)
  // is the natural denominator for each model's part-of-total share.
  rows.push(...breakdownToRows(entries, t.textMuted, { totalForShare: typeof v === "number" ? v : undefined }));

  return {
    header: formatDate(d.date),
    rows,
    footer: noteFooter(d.note, t),
    subsetLabel,
    minWidth: 240,
  };
}

// Elevate the hovered card so a tooltip overflowing its bottom edge isn't
// painted over by the next chart card (a later sibling in the grid).
export function DailyLineChart({
  title, data, globalMax, globalMedian, globalTotal, wfull,
  data2, primaryLabel, label2, globalMax2, globalMedian2, globalTotal2, pairMode = "subset",
  eod, eod2, breakdownByDate, primaryIsDiff = false, subsetLabel,
}: Props) {
  const { theme: t } = useTheme();
  const anchor = chartAnchor(title);
  const { scope } = useStatScope();
  // "window" scopes the MAX / MED / TOTAL lines to the points currently shown;
  // "all" uses the whole-dataset values passed in as props.
  const win = scope === "window";
  const primaryWin = useMemo(() => maxMedian(data.map((d) => d.value)), [data]);
  const secondaryWin = useMemo(() => maxMedian((data2 ?? []).map((d) => d.value)), [data2]);
  const max = win ? primaryWin.max : globalMax;
  const median = win ? primaryWin.median : globalMedian;
  const max2 = win ? secondaryWin.max : (globalMax2 ?? 0);
  const median2 = win ? secondaryWin.median : (globalMedian2 ?? 0);
  const total = win ? primaryWin.total : (globalTotal ?? 0);
  const total2 = win ? secondaryWin.total : (globalTotal2 ?? 0);
  const hasPair = !!data2;
  const c = chartColors(t);
  // House rule: the main series is blue, whether the chart is single-line or
  // the "Hit" half of a pair; the second series ("Destroyed") is red.
  const primaryColor = c.line;
  const secondaryColor = c.lineSecondary;
  const resolvedPrimaryLabel = primaryLabel ?? (hasPair ? "Hit" : title);
  const resolvedSecondaryLabel = label2 ?? "Destroyed";

  // Notes keyed by date, so a date whose every series is null can still show
  // its caveat (recharts hands the tooltip only the x label in that case).
  const noteByDate = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of data) if (d.note) m.set(d.date, d.note);
    for (const d of data2 ?? []) if (d.note && !m.has(d.date)) m.set(d.date, d.note);
    return m;
  }, [data, data2]);

  const chartData = useMemo(() => {
    const trend1 = linearRegression(data);
    const trend2 = data2 ? linearRegression(data2) : null;
    // Fold the diff into its own series so we can regress on it. Only used
    // when `primaryIsDiff` — otherwise the tooltip's "primary trend" IS
    // just trend1 (SBS-style "Hit" is the total, so its trend is trend1).
    const diffSeries: DailyDataPoint[] = data.map((d, i) => {
      const v = d.value;
      const v2 = data2?.[i]?.value ?? null;
      return {
        ...d,
        value: pairMode === "subset" && typeof v === "number" && typeof v2 === "number"
          ? Math.max(0, v - v2)
          : null,
      };
    });
    const trendDiff = data2 && pairMode === "subset" ? linearRegression(diffSeries) : null;
    return data.map<PairedRow>((d, i) => {
      const v2 = data2?.[i]?.value ?? null;
      const v = d.value;
      const diff = pairMode === "subset"
        ? (typeof v === "number" && typeof v2 === "number" ? Math.max(0, v - v2) : null)
        : v;
      return {
        date: d.date,
        is_today: d.is_today,
        value: v,
        value2: v2,
        trend1: trend1[i] ?? null,
        trend2: trend2?.[i] ?? null,
        trendDiff: trendDiff?.[i] ?? null,
        valueDiff: diff,
        eod: d.is_today ? (eod ?? null) : null,
        eod2: d.is_today ? (eod2 ?? null) : null,
        note: d.note,
      };
    });
  }, [data, data2, pairMode, eod, eod2]);

  // One description per x-position, rendered two ways: as the floating hover
  // card and as the pinned sheet's body. A date with no payload at all still
  // resolves here (via `describeGap`) — the hover path used to receive only
  // the axis label and had to look the note up separately.
  const describeRow = useCallback((row: PairedRow): TooltipDescriptor | null => {
    const ctx: DescribeCtx = {
      t, primaryColor,
      primaryLabel: resolvedPrimaryLabel,
      secondaryLabel: resolvedSecondaryLabel,
      pairMode, primaryIsDiff, breakdownByDate, subsetLabel, noteByDate,
    };
    const allNull = row.value == null && (!hasPair || row.value2 == null);
    if (allNull) return describeGap(ctx, row.date);
    return hasPair ? describePaired(ctx, row) : describeSingle(ctx, row);
  }, [
    t, primaryColor, resolvedPrimaryLabel, resolvedSecondaryLabel, pairMode,
    primaryIsDiff, breakdownByDate, subsetLabel, noteByDate, hasPair,
  ]);

  const pin = usePinnedChart({
    chartId: anchor || title,
    title,
    data: chartData,
    xOf: (r) => r.date,
    describe: describeRow,
    formatLabel: (r) => formatDate(r.date),
    cursor: { stroke: t.textMuted, strokeWidth: 1 },
    // These charts carry gap notes, which recharts would otherwise hide along
    // with the empty-payload wrapper.
    showEmptyWrapper: true,
  });
  const pinnedDate = pin.pinnedX as string | null;

  const yMax = hasPair && pairMode === "sum"
    ? Math.max(max + max2, 0)
    : max;

  return (
    <div
      className="chart-card"
      id={anchor || undefined}
      {...pin.cardProps}
      style={{
        background: t.surface,
        border: `1px solid ${t.surfaceBorder}`,
        borderRadius: 8,
        padding: "18px 16px 12px",
        gridColumn: wfull ? "1 / -1" : undefined,
        animation: "fadeIn 0.3s ease both",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        cursor: "pointer",
      }}
    >
      <ChartCardTitle title={title} anchor={anchor} marginBottom={4} />
      <div style={{ display: "flex", gap: 12, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        {hasPair && <span style={{ color: primaryColor }}>● {resolvedPrimaryLabel}</span>}
        <span style={{ color: c.maxReference }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: c.medReference }}>~ MED {median.toLocaleString()}</span>
        <span style={{ color: t.textMuted }}>Σ TOTAL {total.toLocaleString()}</span>
        {hasPair && (
          <>
            <span style={{ color: secondaryColor, marginLeft: 8 }}>● {resolvedSecondaryLabel}</span>
            <span style={{ color: secondaryColor }}>▲ MAX {max2.toLocaleString()}</span>
            <span style={{ color: secondaryColor, opacity: 0.7 }}>~ MED {median2.toLocaleString()}</span>
            <span style={{ color: secondaryColor, opacity: 0.7 }}>Σ TOTAL {total2.toLocaleString()}</span>
          </>
        )}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        {hasPair ? (
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }} {...pin.chartProps}>
            <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
            <XAxis dataKey="date"
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax, yMax)]} />
            {pin.tooltip}
            <ReferenceLine y={median} stroke={c.medReference} strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: c.medReference, fontFamily: FONTS.mono }} />
              <Area type="monotone" dataKey="value2" name={resolvedSecondaryLabel} stackId="1"
              stroke={secondaryColor} strokeWidth={1.5} fill={secondaryColor} fillOpacity={AREA_FILL_OPACITY.destroyed} isAnimationActive={false} />
            <Area type="monotone" dataKey="valueDiff" name={resolvedPrimaryLabel} stackId="1"
              stroke={primaryColor} strokeWidth={1.5} fill={primaryColor} fillOpacity={AREA_FILL_OPACITY.damaged} isAnimationActive={false} />
            {/* Painted last so it reads as a crosshair over the series,
              not a stub buried under a bar. */}
          {pin.cursor}
        </ComposedChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }} {...pin.chartProps}>
            <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
            <XAxis dataKey="date"
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax, max)]} />
            {pin.tooltip}
            <ReferenceLine y={median} stroke={c.medReference} strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: c.medReference, fontFamily: FONTS.mono }} />
              {/* No draw-in animation, matching the two <Area>s above. recharts
                re-runs it whenever the series' props change, so with it on, the
                whole line redrew itself every time the sheet opened, closed, or
                stepped a day — a full re-animation per press of ›. */}
            <Line type="monotone" dataKey="value" name={resolvedPrimaryLabel} stroke={primaryColor} strokeWidth={2} isAnimationActive={false}
              dot={({ key, ...props }) => <CustomDot key={key} {...props} accentColor={t.accent} primaryColor={primaryColor} bgColor={t.surface} noteColor={chartColors(t).noteText} pinnedDate={pinnedDate} />}
              // The hover activeDot is the last piece of hover feedback recharts
              // draws from its own state rather than from `active`, so it has to
              // be switched off by hand while pinned.
              activeDot={pin.isPinned ? false : { r: 5, fill: primaryColor }}
            />
            <Line type="linear" dataKey="trend1" name="Trend" stroke={c.trend} strokeWidth={1.5}
              strokeDasharray="6 3" dot={false} activeDot={false} isAnimationActive={false}
            />
            {/* Painted last so it reads as a crosshair over the series,
              not a stub buried under a bar. */}
          {pin.cursor}
        </LineChart>
        )}
      </ResponsiveContainer>
      {pin.sheet}
    </div>
  );
}
