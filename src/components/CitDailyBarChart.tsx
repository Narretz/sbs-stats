import { useMemo } from "react";
import { Bar, ReferenceLine } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { maxMedian } from "@/utils/windowStats";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import {
  dayTick, entryOfDay, fmtCount, formatEntry, spanBarShape, type SpannedDay,
} from "@/components/spanBarShape";
import { SpanCursor } from "@/components/SpanCursor";
import type { TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";
import { CIT_METRIC_LABELS, type CitMetricKey, type Stat } from "@/types";

// CIT's daily headline figures as bars, one per day. Bars rather than a line
// because of the weekend: CIT posts ONE 48-hour report for Saturday + Sunday,
// and a bar can span both days at the daily-average height, so its area is
// the report's real total — a histogram with one wider bin. A line can only
// put the average on each day, which reads as two measured days.

const MAX_BAR_SIZE = 70;

// One day of the headline series. A weekend report's two days each carry half
// of it; a day no report covers carries nulls.
export interface CitDailyBarRow extends SpannedDay {
  killed: number | null;
  injured: number | null;
}

interface Props {
  title: string;
  data: CitDailyBarRow[];
  // Bottom to top. One key draws a plain bar chart with a median line; two
  // stack, killed at the baseline where its small band stays readable.
  series: CitMetricKey[];
  // Whole-dataset stats per series, for the "all" scope — on the same per-day
  // basis as the bars (a weekend counted as two half days).
  globalStats: Partial<Record<CitMetricKey, Stat>>;
  wfull?: boolean;
}

export function CitDailyBarChart({ title, data, series, globalStats, wfull }: Props) {
  const { theme: t } = useTheme();
  const { scope } = useStatScope();
  const c = chartColors(t);
  const color: Record<CitMetricKey, string> = {
    killed: c.civiliansKilled,
    injured: c.civiliansInjured,
  };
  const stacked = series.length > 1;

  const windowStats = useMemo(() => {
    const out = {} as Record<CitMetricKey, Stat>;
    for (const k of series) out[k] = maxMedian(data.map((d) => d[k]));
    return out;
  }, [data, series]);
  const stat = (k: CitMetricKey): Stat =>
    scope === "window" ? windowStats[k] : (globalStats[k] ?? { max: 0, median: 0, total: 0 });

  // One description per ENTRY: both days of a weekend report describe the
  // report itself — its date span and its real 48-hour figures — so hovering
  // or pinning either day reads the same, and the pinned sheet steps over the
  // weekend in one step (entryOfDay). Only the bar height is the average.
  const describe = (d: CitDailyBarRow): TooltipDescriptor => {
    const header = formatEntry(d);
    if (d.report_date == null) {
      return { header, rows: [], footer: "No CIT report covers this day." };
    }
    const span = d.window_days;
    const whole = (v: number | null) => (v == null ? null : Math.round(v * span));
    // Top of the stack first, as it reads on the chart.
    const rows: TooltipTableRow[] = [...series].reverse().map((k) => ({
      label: CIT_METRIC_LABELS[k], color: color[k], value: whole(d[k]),
    }));
    if (stacked) {
      const total = series.reduce((s, k) => s + (whole(d[k]) ?? 0), 0);
      rows.unshift({ label: "Total", color: t.text, value: total, emphasis: "bold" });
      rows[1] = { ...rows[1], separatorAbove: true };
    }
    const footer = span > 1
      ? `One ${span * 24}-hour weekend report. Drawn across its ${span} days at the ` +
        `daily average (${series.map((k) => `${fmtCount(d[k] ?? 0)} ${k}`).join(", ")} a day) ` +
        `\u2014 CIT did not publish a per-day split.`
      : undefined;
    return { header, rows, footer, formatValue: fmtCount, minWidth: 220 };
  };

  const statsHeader = (
    <div style={{ display: "flex", gap: 12, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
      {[...series].reverse().map((k, i) => {
        const s = stat(k);
        // A single chart keeps the reference-line colours its MED line uses;
        // a stack labels each series in its own colour, as DailyLineChart did.
        const tone = stacked ? color[k] : undefined;
        return (
          <span key={k} style={{ display: "contents" }}>
            {stacked && (
              <span style={{ color: color[k], marginLeft: i > 0 ? 8 : 0 }}>● {CIT_METRIC_LABELS[k]}</span>
            )}
            <span style={{ color: tone ?? c.maxReference }}>▲ MAX {fmtCount(s.max)}</span>
            <span style={{ color: tone ?? c.medReference, opacity: stacked ? 0.7 : 1 }}>~ MED {fmtCount(s.median)}</span>
            <span style={{ color: tone ?? t.textMuted, opacity: stacked ? 0.7 : 1 }}>Σ TOTAL {fmtCount(s.total)}</span>
          </span>
        );
      })}
    </div>
  );

  return (
    <MonthlyChartCard<CitDailyBarRow>
      title={title}
      data={data}
      wfull={wfull}
      describe={describe}
      formatLabel={formatEntry}
      tickFormatter={dayTick}
      showEmptyWrapper
      subheader={statsHeader}
      entryOf={entryOfDay}
      cursor={<SpanCursor rows={data} />}
    >
      {!stacked && (
        <ReferenceLine y={stat(series[0]).median} stroke={c.medReference} strokeDasharray="4 4" strokeOpacity={0.5}
          label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: c.medReference, fontFamily: FONTS.mono }} />
      )}
      {series.map((k) => (
        <Bar key={k} dataKey={k} stackId="a" name={CIT_METRIC_LABELS[k]} maxBarSize={MAX_BAR_SIZE}
             shape={spanBarShape(color[k])} />
      ))}
    </MonthlyChartCard>
  );
}
