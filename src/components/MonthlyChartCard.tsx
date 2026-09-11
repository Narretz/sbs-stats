import type { ReactNode } from "react";
import {
  BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis,
} from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { chartAnchor } from "@/utils/chartAnchor";
import { usePinnedChart } from "@/components/usePinnedChart";
import type { TooltipDescriptor } from "@/components/TooltipTable";

// Shared chrome for monthly bar charts: card wrapper, title, optional legend,
// ResponsiveContainer + BarChart + axes + grid + tooltip. Consumers pass in the
// <Bar> elements as children and a tooltip render function — the data shape
// and per-series semantics stay in the consumer.
//
// Used by MonthlyBarChart (single-series + projection) and TargetsStackedChart
// (destroyed/damaged stack with total). To add a new monthly bar chart with a
// different shape, drop in here too.

export interface ChartLegendEntry {
  label: string;
  color: string;
}

interface Props<TData extends { date: string }> {
  title: string;
  data: TData[];
  // Optional legend rendered just below the title (matches the bar fills).
  legend?: ChartLegendEntry[];
  // Span the full ChartGrid row instead of fitting in a column.
  wfull?: boolean;
  // Describes one month for both the hover card and the pinned sheet; the
  // shell wires the tooltip, the pin and the sheet for you.
  describe?: (row: TData) => TooltipDescriptor | null;
  // Human label for the pinned sheet's header. Defaults to the raw date.
  formatLabel?: (row: TData) => ReactNode;
  // Optional extra content rendered between the title/legend and the chart.
  // Used to show MAX/MED/TOTAL stat labels in the same row-style as
  // DailyLineChart, kept opt-in so consumers without window stats don't pay.
  subheader?: ReactNode;
  // `<Bar>` elements — one or more. May also include `<ReferenceLine>` etc.
  children: ReactNode;
}

export function MonthlyChartCard<TData extends { date: string }>({
  title, data, legend, wfull, describe, formatLabel, subheader, children,
}: Props<TData>) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const anchor = chartAnchor(title);
  const pin = usePinnedChart({
    chartId: anchor || title,
    title,
    data,
    xOf: (d) => d.date,
    describe: describe ?? (() => null),
    formatLabel,
  });

  return (
    <div className="chart-card" id={anchor || undefined} {...pin.cardProps} style={{
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: wfull ? "1 / -1" : undefined,
      animation: "fadeIn 0.3s ease both",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      cursor: describe ? "pointer" : undefined,
    }}>
      <ChartCardTitle title={title} anchor={anchor} marginBottom={14} />
      {legend && (
        <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 10 }}>
          {legend.map((l) => (
            <span key={l.label} style={{ color: l.color }}>■ {l.label}</span>
          ))}
        </div>
      )}
      {subheader}
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }} {...pin.chartProps}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: string) => v.slice(0, 7).replace("-", "/")}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} />
          {describe && pin.tooltip}
          {children}
          {/* Painted last so it reads as a crosshair over the bars, not a
              stub buried under one. */}
          {describe && pin.cursor}
        </BarChart>
      </ResponsiveContainer>
      {pin.sheet}
    </div>
  );
}
