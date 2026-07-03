import { useMemo } from "react";
import { Bar, Cell, ReferenceLine } from "recharts";
import type { ModelBreakdownEntry, MonthlyDataPoint } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { maxMedian } from "@/utils/windowStats";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { MonthlyChartCard, type TooltipRenderProps } from "@/components/MonthlyChartCard";
import { ModelBreakdownTable } from "@/components/ModelBreakdownTable";
import { TooltipCard, TooltipTable, type TooltipTableRow } from "@/components/TooltipTable";

interface Props {
  title: string;
  data: MonthlyDataPoint[];
  wfull: boolean;
  // Whole-dataset stats for the "all" scope. When omitted, the chart renders
  // window-scoped stats only and shows no reference lines for the "all"
  // setting (window still works since it's computed from `data`).
  globalMax?: number;
  globalMedian?: number;
  globalTotal?: number;
  // Optional per-month breakdown rendered below the standard tooltip rows.
  // Used by the RU air-attacks aggregate "All" monthly bar chart to break the
  // total into drone / cruise / ballistic.
  breakdownByMonth?: Map<string, ModelBreakdownEntry[]>;
  // First-column header for the breakdown table. Default "Model"; pass
  // "Category" for the all-attacks aggregate.
  breakdownHeader?: string;
}

// Cap bar width so a chart with few data points (e.g. SBU Alfa's 3 months)
// doesn't render absurdly fat bars. With many months, recharts gives each bar
// less than this anyway and the cap is a no-op.
const MAX_BAR_SIZE = 70;

export function MonthlyBarChart({
  title, data, wfull, breakdownByMonth, breakdownHeader,
  globalMax, globalMedian, globalTotal,
}: Props) {
  const { theme: t } = useTheme();
  const { scope } = useStatScope();
  const c = chartColors(t);
  const lastIdx = data.length - 1;

  // Projected segment (current month's forecast) uses the alpha-suffixed
  // current-bar color — see chartColors.ts.
  const projectedFill = c.barCurrentProjected;

  // Mirror DailyLineChart: "window" scope reads MAX/MED/TOTAL off the visible
  // data; "all" uses the whole-dataset values passed in as props (falls back
  // to window when a page doesn't supply globals).
  const win = scope === "window";
  const windowStats = useMemo(() => maxMedian(data.map((d) => d.value)), [data]);
  const max = win ? windowStats.max : (globalMax ?? windowStats.max);
  const median = win ? windowStats.median : (globalMedian ?? windowStats.median);
  const total = win ? windowStats.total : (globalTotal ?? windowStats.total);

  const renderTooltip = ({ active, payload }: TooltipRenderProps<MonthlyDataPoint>) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const entries = breakdownByMonth?.get(d.date.slice(0, 7)) ?? [];
    // "Day X of Y" pushed to the right of the header — smaller (fontSize 10)
    // suffix aligned to the tooltip's trailing edge. See the sibling
    // MonthlyTargetPairChart comment for why width:100% is required (recharts
    // wraps tooltips in a shrink-to-fit container so space-between needs an
    // explicit width to distribute).
    const header = d.projected != null && d.projection_day != null && d.projection_days_in_month != null ? (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", width: "100%" }}>
        <span>{d.date}</span>
        <span style={{ fontSize: 10 }}>
          Day {d.projection_day} of {d.projection_days_in_month}
        </span>
      </div>
    ) : d.date;
    const rows: TooltipTableRow[] = [
      { label: "Actual", color: t.primary, value: d.value ?? null, projected: d.projected ?? null },
    ];
    const footer = (
      <>
        {d.note && (
          <div style={{ color: t.textImportant, fontSize: 10, marginTop: 6, maxWidth: 220 }}>
            ⚠ {d.note}
          </div>
        )}
        {entries.length > 0 && <ModelBreakdownTable entries={entries} t={t} header={breakdownHeader} />}
      </>
    );
    return (
      <TooltipCard header={header} minWidth={200} footer={footer}>
        <TooltipTable rows={rows} />
      </TooltipCard>
    );
  };

  const statsHeader = (
    <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
      <span style={{ color: t.accent }}>▲ MAX {max.toLocaleString()}</span>
      <span style={{ color: t.muted }}>~ MED {median.toLocaleString()}</span>
      <span style={{ color: t.textMuted }}>Σ TOTAL {total.toLocaleString()}</span>
    </div>
  );

  return (
    <MonthlyChartCard title={title} data={data} wfull={wfull} tooltip={renderTooltip} subheader={statsHeader}>
      <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
        label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
      <Bar dataKey="value" stackId="a" name="Actual" maxBarSize={MAX_BAR_SIZE}>
        {data.map((d, i) => (
          <Cell
            key={`val-${i}`}
            fill={i === lastIdx ? c.barCurrent : c.barDefault}
            stroke={d.note ? c.noteText : undefined}
            strokeWidth={d.note ? 1.5 : undefined}
            strokeDasharray={d.note ? "3 2" : undefined}
          />
        ))}
      </Bar>
      <Bar dataKey="gap" stackId="a" name="Projected" radius={[3, 3, 0, 0]} maxBarSize={MAX_BAR_SIZE}>
        {data.map((_, i) => (
          <Cell key={`gap-${i}`} fill={i === lastIdx ? projectedFill : "transparent"} />
        ))}
      </Bar>
    </MonthlyChartCard>
  );
}
