import { useMemo, type ReactNode } from "react";
import { Bar, ReferenceLine } from "recharts";
import { noteOutline, styledBar } from "@/components/barShape";
import type { DailyDataPoint, ModelBreakdownEntry } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { useRankedBars } from "@/hooks/useRanking";
import { maxMedian } from "@/utils/windowStats";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import { breakdownToRows, type SheetSource, type TooltipDescriptor, type TooltipTableRow } from "@/components/TooltipTable";
import { rankedAxisProps } from "@/utils/barOrder";

// A daily series ranked by value (utils/barOrder): what DailyLineChart and
// DailyMultiLineChart draw on a ranking page. Bars, not a line — neighbouring
// days are no longer neighbours in time, so there is nothing to join and no
// trend to fit. A pair (hit and destroyed, launched and intercepted) ranks by
// its first series and draws the second beside it, as the monthly pair chart
// does. Always full width: a ranked axis labels every bar.

interface Props {
  title: string;
  /** Every day of the ranking's span, in date order; ranked here. */
  data: DailyDataPoint[];
  label?: string;
  globalMax?: number;
  globalMedian?: number;
  globalTotal?: number;
  data2?: DailyDataPoint[];
  label2?: string;
  globalMax2?: number;
  globalMedian2?: number;
  globalTotal2?: number;
  subsetLabel?: string;
  breakdownByDate?: Map<string, ModelBreakdownEntry[]>;
  sourcesByDate?: Map<string, SheetSource[]>;
  detailByDate?: Map<string, ReactNode>;
  /** Drawn in the second series' red: the destroyed half of a pair split
   *  into a chart of its own. */
  secondary?: boolean;
}

interface RankedRow extends DailyDataPoint {
  value2: number | null;
}

const MAX_BAR_SIZE = 40;

export function DailyRankedChart({
  title, data, label, globalMax, globalMedian, globalTotal,
  data2, label2, globalMax2, globalMedian2, globalTotal2,
  subsetLabel, breakdownByDate, sourcesByDate, detailByDate, secondary,
}: Props) {
  const { theme: t } = useTheme();
  const { scope } = useStatScope();
  const c = chartColors(t);
  // One series is the main series of its own chart — blue — even one split
  // from a multi-series chart, whose line had a colour of its own. The one
  // exception is a pair's second half, which keeps its red.
  const primaryColor = secondary ? c.destroyed : data2 ? c.damaged : c.barDefault;

  const rows = useMemo<RankedRow[]>(() => {
    const second = new Map((data2 ?? []).map((d) => [d.date, d.value]));
    return data.map((d) => ({ ...d, value2: second.get(d.date) ?? null }));
  }, [data, data2]);
  // Today is still being reported.
  const ranked = useRankedBars(rows, (d) => d.is_today);
  const bars = useMemo(() => ranked?.bars ?? [], [ranked]);

  const win = scope === "window";
  const stats = useMemo(() => maxMedian(bars.map((d) => d.value)), [bars]);
  const stats2 = useMemo(() => maxMedian(bars.map((d) => d.value2)), [bars]);
  const pick = (w: { max: number; median: number; total: number }, max?: number, median?: number, total?: number) => ({
    max: win ? w.max : (max ?? w.max),
    median: win ? w.median : (median ?? w.median),
    total: win ? w.total : (total ?? w.total),
  });
  const s1 = pick(stats, globalMax, globalMedian, globalTotal);
  const s2 = pick(stats2, globalMax2, globalMedian2, globalTotal2);

  const describe = (d: RankedRow): TooltipDescriptor => {
    const fill = detailByDate?.get(d.date);
    const footer = fill || d.note ? (
      <>
        {fill}
        {d.note && (
          <div className="tooltip-note" style={{ color: c.noteText, marginTop: 6, whiteSpace: "pre-line" }}>
            ⚠ {d.note}
          </div>
        )}
      </>
    ) : null;
    const rows: TooltipTableRow[] = data2
      ? subsetLabel !== undefined
        ? [{ label: label ?? title, color: primaryColor, value: d.value, subset: d.value2 }]
        : [
            { label: label ?? title, color: primaryColor, value: d.value },
            { label: label2 ?? "", color: c.destroyed, value: d.value2 },
          ]
      : [{ label: label ?? "Actual", color: primaryColor, value: d.value }];
    rows.push(...breakdownToRows(breakdownByDate?.get(d.date) ?? [], t.textMuted, { totalForShare: d.value ?? undefined }));
    return {
      header: <>#{bars.indexOf(d) + 1} · {d.date}</>,
      rows, footer, subsetLabel, minWidth: 200, sources: sourcesByDate?.get(d.date),
    };
  };

  const statsHeader = (
    <div style={{ display: "flex", rowGap: 8, columnGap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
      {data2 && <span style={{ color: primaryColor }}>● {label ?? title}</span>}
      <span style={{ color: c.maxReference }}>▲ MAX {s1.max.toLocaleString()}</span>
      <span style={{ color: c.medReference }}>~ MED {s1.median.toLocaleString()}</span>
      <span style={{ color: t.textMuted }}>Σ TOTAL {s1.total.toLocaleString()}</span>
      {data2 && <>
        <span style={{ color: c.destroyed }}>● {label2}</span>
        <span style={{ color: c.destroyed }}>▲ MAX {s2.max.toLocaleString()}</span>
        <span style={{ color: c.destroyed, opacity: 0.7 }}>~ MED {s2.median.toLocaleString()}</span>
        <span style={{ color: c.destroyed, opacity: 0.7 }}>Σ TOTAL {s2.total.toLocaleString()}</span>
      </>}
      {ranked && ranked.excluded > 0 && <span style={{ color: t.textMuted }}>excl. today</span>}
    </div>
  );

  return (
    <MonthlyChartCard
      title={title} data={bars} wfull describe={describe} subheader={statsHeader}
      tickFormatter={(date) => date} periodOf={(d) => d.date} axis={rankedAxisProps(bars.length)}
    >
      <ReferenceLine y={s1.median} stroke={c.medReference} strokeDasharray="4 4" strokeOpacity={0.5}
        label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: c.medReference, fontFamily: FONTS.mono }} />
      <Bar dataKey="value" name={label ?? "Actual"} maxBarSize={MAX_BAR_SIZE}
        shape={styledBar<RankedRow>((d) => ({ fill: primaryColor, ...noteOutline(d.note, c.noteText) }))} />
      {data2 && (
        <Bar dataKey="value2" name={label2} maxBarSize={MAX_BAR_SIZE}
          shape={styledBar<RankedRow>(() => ({ fill: c.destroyed }))} />
      )}
    </MonthlyChartCard>
  );
}
