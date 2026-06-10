import type { ReactNode } from "react";
import {
  BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";

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

export interface TooltipRenderProps<TData = Record<string, unknown>> {
  active?: boolean;
  payload?: Array<{ payload: TData }>;
}

interface Props<TData extends { date: string }> {
  title: string;
  data: TData[];
  // Optional legend rendered just below the title (matches the bar fills).
  legend?: ChartLegendEntry[];
  // Span the full ChartGrid row instead of fitting in a column.
  wfull?: boolean;
  // Renders the inner tooltip content; the shell wires `<Tooltip>` for you.
  tooltip?: (props: TooltipRenderProps<TData>) => ReactNode;
  // `<Bar>` elements — one or more.
  children: ReactNode;
}

export function MonthlyChartCard<TData extends { date: string }>({
  title, data, legend, wfull, tooltip, children,
}: Props<TData>) {
  const { theme: t } = useTheme();
  const c = chartColors(t);

  return (
    <div style={{
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: wfull ? "1 / -1" : undefined,
      animation: "fadeIn 0.3s ease both",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <div style={{
        fontFamily: FONTS.display, fontWeight: 700, fontSize: 12,
        color: t.textMuted, letterSpacing: "0.07em",
        textTransform: "uppercase", marginBottom: 14,
      }}>
        {title}
      </div>
      {legend && (
        <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 10 }}>
          {legend.map((l) => (
            <span key={l.label} style={{ color: l.color }}>■ {l.label}</span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            tickFormatter={(v: string) => v.slice(0, 7).replace("-", "/")}
          />
          <YAxis tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} />
          {tooltip && (
            <Tooltip
              content={(props) =>
                tooltip(props as unknown as TooltipRenderProps<TData>)
              }
              allowEscapeViewBox={{ x: false, y: true }}
            />
          )}
          {children}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
