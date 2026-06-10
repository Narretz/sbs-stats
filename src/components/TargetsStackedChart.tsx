import { Bar, Cell } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { MonthlyChartCard, type TooltipRenderProps } from "@/components/MonthlyChartCard";

// `total` is included so the tooltip can show it explicitly, even though
// (destroyed + damaged) equals it by construction (SBU's own phrasing).
export interface TargetsStackPoint {
  date: string;
  destroyed: number | null;
  damaged: number | null;
  total: number | null;
}

interface Props {
  title: string;
  data: TargetsStackPoint[];
  wfull?: boolean;
}

// Same cap as MonthlyBarChart — keeps few-bar charts from rendering absurdly fat.
const MAX_BAR_SIZE = 70;

export function TargetsStackedChart({ title, data, wfull }: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const lastIdx = data.length - 1;

  const renderTooltip = ({ active, payload }: TooltipRenderProps<TargetsStackPoint>) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const num = (n: number | null) => (n == null ? "n/a" : n.toLocaleString());
    return (
      <div style={{
        background: t.surface, border: `1px solid ${t.border}`,
        borderRadius: 6, padding: "10px 14px",
        fontFamily: FONTS.mono, fontSize: 12,
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      }}>
        <div style={{ color: t.textMuted, marginBottom: 6 }}>{d.date}</div>
        <div style={{ color: c.destroyed }}>
          Destroyed: <span style={{ color: t.text, fontWeight: 700 }}>{num(d.destroyed)}</span>
        </div>
        <div style={{ color: c.damaged }}>
          Damaged: <span style={{ color: t.text, fontWeight: 700 }}>{num(d.damaged)}</span>
        </div>
        <div style={{ color: t.textMuted, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${t.border}` }}>
          Total: <span style={{ color: t.text, fontWeight: 700 }}>{num(d.total)}</span>
        </div>
      </div>
    );
  };

  // `destroyed` on the bottom (the "permanent" half), `damaged` on top —
  // reading bottom-up matches "fully neutralised → partially neutralised".
  return (
    <MonthlyChartCard
      title={title}
      data={data}
      wfull={wfull}
      tooltip={renderTooltip}
      legend={[
        { label: "Destroyed", color: c.destroyed },
        { label: "Damaged", color: c.damaged },
      ]}
    >
      <Bar dataKey="destroyed" stackId="a" name="Destroyed" maxBarSize={MAX_BAR_SIZE}>
        {data.map((_, i) => (
          <Cell key={`d-${i}`} fill={i === lastIdx ? c.destroyedCurrent : c.destroyed} />
        ))}
      </Bar>
      <Bar dataKey="damaged" stackId="a" name="Damaged" radius={[3, 3, 0, 0]} maxBarSize={MAX_BAR_SIZE}>
        {data.map((_, i) => (
          <Cell key={`m-${i}`} fill={i === lastIdx ? c.barCurrent : c.damaged} />
        ))}
      </Bar>
    </MonthlyChartCard>
  );
}
