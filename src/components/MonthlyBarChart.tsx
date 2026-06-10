import { Bar, Cell } from "recharts";
import type { MonthlyDataPoint } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { MonthlyChartCard, type TooltipRenderProps } from "@/components/MonthlyChartCard";

interface Props {
  title: string;
  data: MonthlyDataPoint[];
  wfull: boolean;
}

// Cap bar width so a chart with few data points (e.g. SBU Alfa's 3 months)
// doesn't render absurdly fat bars. With many months, recharts gives each bar
// less than this anyway and the cap is a no-op.
const MAX_BAR_SIZE = 70;

export function MonthlyBarChart({ title, data, wfull }: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const lastIdx = data.length - 1;

  // Projected segment (current month's forecast) uses the alpha-suffixed
  // current-bar color — see chartColors.ts.
  const projectedFill = c.barCurrentProjected;

  const renderTooltip = ({ active, payload }: TooltipRenderProps<MonthlyDataPoint>) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
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
      </div>
    );
  };

  return (
    <MonthlyChartCard title={title} data={data} wfull={wfull} tooltip={renderTooltip}>
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
