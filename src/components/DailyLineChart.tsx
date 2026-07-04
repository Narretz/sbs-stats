import {
  LineChart, Line, ComposedChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, type DotProps,
} from "recharts";
import { useMemo, type ReactNode } from "react";
import type { DailyDataPoint, EodEstimate, ModelBreakdownEntry, PairMode } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { maxMedian } from "@/utils/windowStats";
import { FONTS, type Theme } from "@/theme";
import { AREA_FILL_OPACITY, COLOR_DESTROYED, chartColors } from "@/chartColors";
import { TooltipCard, TooltipTable, breakdownToRows, type TooltipTableRow } from "@/components/TooltipTable";

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

function CustomDot(props: DotProps & { payload?: PairedRow; accentColor: string; primaryColor: string; bgColor: string; noteColor: string }) {
  const { cx, cy, payload, accentColor, primaryColor, bgColor, noteColor } = props;
  if (cx == null || cy == null) return null;
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

interface TooltipPayloadEntry {
  payload?: PairedRow;
}

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
      <span style={{ fontSize: 11}}>~{fmt(e.projected)}</span><span style={{ fontSize: 10, opacity: 0.9 }}> ({Math.round(e.fraction * 100)}%)</span>
    </>
  );
}

// Prose-only footer: the warning note lives below the TooltipTable, not
// inside its row grid. EoD estimates used to live here too but moved into
// the table so their projected + fraction align with the actual columns.
function NoteFooter({ d, t }: { d: PairedRow; t: Theme }) {
  if (!d.note) return null;
  return (
    <div style={{ color: chartColors(t).noteText, fontSize: 10, marginTop: 6, maxWidth: 280, whiteSpace: "pre-line" }}>
      ⚠ {d.note}
    </div>
  );
}

function SingleTooltip({
  active, payload, t, primaryColor, primaryLabel, breakdownByDate, subsetLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  t: Theme;
  primaryColor: string;
  primaryLabel: string;
  breakdownByDate?: Map<string, ModelBreakdownEntry[]>;
  subsetLabel?: string;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const d = payload[0].payload;
  const entries = breakdownByDate?.get(d.date) ?? [];
  const rows: TooltipTableRow[] = [
    { label: primaryLabel, color: primaryColor, value: d.value, trend: d.trend1 },
  ];
  if (d.is_today && d.eod) {
    rows.push({ label: "EoD est", color: t.textMuted, value: fmtEod(d.eod) });
  }
  rows.push(...breakdownToRows(entries, t.textMuted, { totalForShare: typeof d.value === "number" ? d.value : undefined }));
  return (
    <TooltipCard header={formatDate(d.date)} minWidth={180} footer={<NoteFooter d={d} t={t} />}>
      <TooltipTable rows={rows} subsetLabel={subsetLabel} />
    </TooltipCard>
  );
}

function PairedTooltip({
  active, payload, t, primaryColor, primaryLabel, secondaryLabel, pairMode,
  primaryIsDiff, breakdownByDate, subsetLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  t: Theme;
  primaryColor: string;
  primaryLabel: string;
  secondaryLabel: string;
  pairMode: PairMode;
  primaryIsDiff: boolean;
  breakdownByDate?: Map<string, ModelBreakdownEntry[]>;
  subsetLabel?: string;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const d = payload[0].payload;
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
      label: secondaryLabel, color: COLOR_DESTROYED,
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

  return (
    <TooltipCard header={formatDate(d.date)} minWidth={240} footer={<NoteFooter d={d} t={t} />}>
      <TooltipTable rows={rows} subsetLabel={subsetLabel} />
    </TooltipCard>
  );
}

// Elevate the hovered card so a tooltip overflowing its bottom edge isn't
// painted over by the next chart card (a later sibling in the grid).
export function DailyLineChart({
  title, data, globalMax, globalMedian, globalTotal, wfull,
  data2, primaryLabel, label2, globalMax2, globalMedian2, globalTotal2, pairMode = "subset",
  eod, eod2, breakdownByDate, primaryIsDiff = false, subsetLabel,
}: Props) {
  const { theme: t } = useTheme();
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
  // Single-line charts use the accent (red). On paired charts the whole "Hit"
  // series (line + area) is blue so it stays distinguishable from the red
  // "Destroyed" series.
  const primaryColor = t.accent;
  const hitFill = t.primary;
  const resolvedPrimaryLabel = primaryLabel ?? (hasPair ? "Hit" : title);
  const resolvedSecondaryLabel = label2 ?? "Destroyed";

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

  const yMax = hasPair && pairMode === "sum"
    ? Math.max(max + max2, 0)
    : max;

  return (
    <div className="chart-card" style={{
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
      <div style={{ display: "flex", gap: 12, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        {hasPair && <span style={{ color: hitFill }}>● {resolvedPrimaryLabel}</span>}
        <span style={{ color: t.accent }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: t.muted }}>~ MED {median.toLocaleString()}</span>
        <span style={{ color: t.textMuted }}>Σ TOTAL {total.toLocaleString()}</span>
        {hasPair && (
          <>
            <span style={{ color: COLOR_DESTROYED, marginLeft: 8 }}>● {resolvedSecondaryLabel}</span>
            <span style={{ color: COLOR_DESTROYED }}>▲ MAX {max2.toLocaleString()}</span>
            <span style={{ color: COLOR_DESTROYED, opacity: 0.7 }}>~ MED {median2.toLocaleString()}</span>
            <span style={{ color: COLOR_DESTROYED, opacity: 0.7 }}>Σ TOTAL {total2.toLocaleString()}</span>
          </>
        )}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        {hasPair ? (
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
            <XAxis dataKey="date"
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax, yMax)]} />
            <Tooltip
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 9999 }}
              cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
              content={(props) => (
                <PairedTooltip
                  active={props.active}
                  payload={props.payload as TooltipPayloadEntry[] | undefined}
                  t={t}
                  primaryColor={hitFill}
                  primaryLabel={resolvedPrimaryLabel}
                  secondaryLabel={resolvedSecondaryLabel}
                  pairMode={pairMode}
                  primaryIsDiff={primaryIsDiff}
                  breakdownByDate={breakdownByDate}
                  subsetLabel={subsetLabel}
                />
              )}
            />
            <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
            <Area type="monotone" dataKey="value2" name={resolvedSecondaryLabel} stackId="1"
              stroke={COLOR_DESTROYED} strokeWidth={1.5} fill={COLOR_DESTROYED} fillOpacity={AREA_FILL_OPACITY.destroyed} isAnimationActive={false} />
            <Area type="monotone" dataKey="valueDiff" name={resolvedPrimaryLabel} stackId="1"
              stroke={hitFill} strokeWidth={1.5} fill={hitFill} fillOpacity={AREA_FILL_OPACITY.damaged} isAnimationActive={false} />
          </ComposedChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
            <XAxis dataKey="date"
              tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
              tickLine={false} axisLine={false}
              tickFormatter={(v: string) => { const p = v.slice(5).split('-'); return `${p[1]}/${p[0]}`; }}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax, max)]} />
            <Tooltip
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 9999 }}
              cursor={{ stroke: t.textMuted, strokeWidth: 1 }}
              content={(props) => (
                <SingleTooltip
                  active={props.active}
                  payload={props.payload as TooltipPayloadEntry[] | undefined}
                  t={t}
                  primaryColor={primaryColor}
                  primaryLabel={resolvedPrimaryLabel}
                  breakdownByDate={breakdownByDate}
                  subsetLabel={subsetLabel}
                />
              )}
            />
            <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
            <Line type="monotone" dataKey="value" name={resolvedPrimaryLabel} stroke={primaryColor} strokeWidth={2}
              dot={({ key, ...props }) => <CustomDot key={key} {...props} accentColor={t.accent} primaryColor={primaryColor} bgColor={t.surface} noteColor={chartColors(t).noteText} />}
              activeDot={{ r: 5, fill: primaryColor }}
            />
            <Line type="linear" dataKey="trend1" name="Trend" stroke={t.muted} strokeWidth={1.5}
              strokeDasharray="6 3" dot={false} activeDot={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
