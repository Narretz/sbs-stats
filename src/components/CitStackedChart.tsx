import { useMemo, type ReactNode } from "react";
import { Bar, ReferenceLine } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { maxMedian } from "@/utils/windowStats";
import { stackTotal } from "@/utils/citTerritory";
import { projectionBasis } from "@/utils/monthProjection";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import {
  dayTick, entryOfDay, fmtCount, formatEntry, spanBarShape, type SpannedDay,
} from "@/components/spanBarShape";
import { SpanCursor } from "@/components/SpanCursor";
import type { SheetSource, TooltipDescriptor } from "@/components/TooltipTable";
import type { Stat } from "@/types";
import { formatMonth } from "@/utils/dateFormat";

// The CIT pages' one chart shape: a stack of series over days or months, with
// the median of the stack's total as the reference line. Its two uses —
// the headline killed / injured (CitHeadlineChart) and the controlling-side
// split (CitTerritoryChart) — differ only in their series and their tooltip
// rows, which they pass in.
//
// Daily, a weekend report is ONE bar spanning both its days at the daily-
// average height (spanBarShape), so its area is the report's real total, and
// both days hover, pin and step as that one report. Monthly, the month still
// being reported carries its projection as one translucent segment on top.

const MAX_BAR_SIZE = 70;

export interface CitStackSeries<K extends string> {
  key: K;
  label: string;
  color: string;
}

// What every row carries beyond its series values. Daily rows are SpannedDay;
// a monthly row in progress carries its projection's basis and the part of
// the projected total still to come.
export interface CitStackRowBase {
  date: string;
  projection?: { coveredDays: number; daysInMonth: number };
  projectedGap?: number;
}

interface Props<K extends string, Row extends CitStackRowBase & Partial<Record<K, number | null>>> {
  title: string;
  data: Row[];
  granularity: "daily" | "monthly";
  // Bottom to top.
  series: readonly CitStackSeries<K>[];
  // The hovered row's tooltip, minus its header — the date (and a month's
  // projection basis), which is the same for every use and set here.
  describe: (row: Row, label: string) => Omit<TooltipDescriptor, "header">;
  // "stats": each series with its MAX / MED / TOTAL, for figures that are
  // counts in their own right. "legend": swatches only.
  header: "stats" | "legend";
  // What the median line's total is, for its entry in the header.
  totalLabel: string;
  // Whole-dataset stats per series and for their sum (`all`), for the "all"
  // scope; a missing one falls back to the window's.
  globalStats?: Partial<Record<K | "all", Stat>>;
  // A line under the header.
  caveat?: ReactNode;
  wfull?: boolean;
  // The primary sources behind each date (the posts its figures were read
  // from), linked in the pinned sheet only — see TooltipDescriptor.sources.
  sourcesByDate?: Map<string, SheetSource[]>;
}

export function CitStackedChart<K extends string, Row extends CitStackRowBase & Partial<Record<K, number | null>>>({
  title, data, granularity, series, describe, header, totalLabel, globalStats, caveat, wfull, sourcesByDate,
}: Props<K, Row>) {
  const { theme: t } = useTheme();
  const { scope } = useStatScope();
  const c = chartColors(t);
  const daily = granularity === "daily";

  const windowStats = useMemo(() => {
    const out = {} as Record<K | "all", Stat>;
    for (const s of series) out[s.key] = maxMedian(data.map((d) => d[s.key]));
    out.all = maxMedian(data.map((d) => stackTotal(d, series.map((s) => s.key))));
    return out;
  }, [data, series]);
  const stat = (k: K | "all"): Stat =>
    scope === "window" ? windowStats[k] : (globalStats?.[k] ?? windowStats[k]);
  const hasProjection = data.some((d) => d.projectedGap != null);

  const label = (d: Row): string =>
    daily ? formatEntry(d as unknown as SpannedDay) : formatMonth(d.date);

  const describeRow = (d: Row): TooltipDescriptor => {
    const p = d.projection;
    const head = p ? (
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{label(d)}</span>
        <span style={{ fontSize: 10, marginLeft: 6 }}>{projectionBasis(p.coveredDays, p.daysInMonth)}</span>
      </div>
    ) : label(d);
    return { header: head, formatValue: fmtCount, sources: sourcesByDate?.get(d.date), ...describe(d, label(d)) };
  };

  const top = [...series].reverse();
  const headerRow = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: header === "stats" ? 12 : "6px 16px", marginBottom: 10, fontFamily: FONTS.mono, fontSize: header === "stats" ? 11 : 10 }}>
      {header === "stats"
        ? top.map((s, i) => {
            const st = stat(s.key);
            return (
              <span key={s.key} style={{ display: "contents" }}>
                <span style={{ color: s.color, marginLeft: i > 0 ? 8 : 0 }}>● {s.label}</span>
                <span style={{ color: s.color }}>▲ MAX {fmtCount(st.max)}</span>
                <span style={{ color: s.color, opacity: 0.7 }}>~ MED {fmtCount(st.median)}</span>
                <span style={{ color: s.color, opacity: 0.7 }}>Σ TOTAL {fmtCount(st.total)}</span>
              </span>
            );
          })
        : series.map((s) => <span key={s.key} style={{ color: s.color }}>■ {s.label}</span>)}
      <span style={{ color: c.medReference, marginLeft: header === "stats" ? 8 : 0 }}>
        ~ MED {totalLabel} {fmtCount(stat("all").median)}
      </span>
      {hasProjection && (
        <span style={{ color: t.textMuted, marginLeft: header === "stats" ? 8 : 0 }}>
          <span style={{ color: c.stackProjected }}>■</span> Projected (month in progress)
        </span>
      )}
    </div>
  );

  return (
    <MonthlyChartCard<Row>
      title={title}
      data={data}
      wfull={wfull}
      describe={describeRow}
      // The hover card formats the date, so the sheet's stepper must too.
      formatLabel={label}
      tickFormatter={daily ? dayTick : undefined}
      // A day no report covers says so on hover; see the callers' describe.
      showEmptyWrapper={daily}
      entryOf={daily ? (d) => entryOfDay(d as unknown as SpannedDay) : undefined}
      cursor={daily ? <SpanCursor rows={data as unknown as SpannedDay[]} /> : undefined}
      subheader={<>
        {headerRow}
        {caveat && (
          <div style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, marginBottom: 10 }}>{caveat}</div>
        )}
      </>}
    >
      {series.map((s) => (
        <Bar key={s.key} dataKey={s.key} stackId="a" name={s.label} maxBarSize={MAX_BAR_SIZE}
             fill={s.color} shape={daily ? spanBarShape(s.color) : undefined} />
      ))}
      {hasProjection && (
        <Bar dataKey="projectedGap" stackId="a" name="Projected" maxBarSize={MAX_BAR_SIZE} fill={c.stackProjected} />
      )}
      {/* After the bars, so the line reads over the stack rather than behind it. */}
      <ReferenceLine y={stat("all").median} stroke={c.medReference} strokeDasharray="4 4" strokeOpacity={0.5}
        label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: c.medReference, fontFamily: FONTS.mono }} />
    </MonthlyChartCard>
  );
}
