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
    return (
      <div style={{
        background: t.surface, border: `1px solid ${t.border}`,
        borderRadius: 6, padding: "10px 14px",
        fontFamily: FONTS.mono, fontSize: 12,
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      }}>
        <div style={{ color: t.textMuted, marginBottom: 6 }}>{d.date}</div>
        <div style={{ color: t.primary }}>
          Actual: <span style={{ color: t.text, fontWeight: 700 }}>{d.value == null ? "n/a" : d.value.toLocaleString()}</span>
        </div>
        {d.projected != null && (
          <>
            <div style={{ color: t.accent }}>
              Projected: <span style={{ color: t.text, fontWeight: 700 }}>{d.projected.toLocaleString()}</span>
            </div>
            <div style={{ color: t.textMuted, fontSize: 10, marginTop: 4 }}>
              Day {d.projection_day} of {d.projection_days_in_month}
            </div>
          </>
        )}
        {d.note && (
          <div style={{ color: t.textImportant, fontSize: 10, marginTop: 6, maxWidth: 220 }}>
            ⚠ {d.note}
          </div>
        )}
        {entries.length > 0 && <ModelBreakdownTable entries={entries} t={t} header={breakdownHeader} />}
      </div>
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
      <ReferenceLine y={max} stroke={t.accent} strokeDasharray="4 4" strokeOpacity={0.6}
        label={{ value: "MAX", position: "insideTopRight", fontSize: 9, fill: t.accent, fontFamily: FONTS.mono }} />
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
