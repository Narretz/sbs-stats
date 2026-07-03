import { Bar, Cell } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { MonthlyChartCard, type TooltipRenderProps } from "@/components/MonthlyChartCard";
import { TooltipCard, TooltipTable, type TooltipTableRow } from "@/components/TooltipTable";

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
    const totalN = d.total ?? 0;
    const pctOf = (v: number | null): number | null =>
      v != null && totalN > 0 ? (v / totalN) * 100 : null;
    // Total on top (bold), components below with per-component share of
    // total. The share column is added automatically because the component
    // rows populate `share`.
    const rows: TooltipTableRow[] = [
      { label: "Total", color: t.text, value: d.total, emphasis: "bold" },
      { label: "Destroyed", color: c.destroyed, value: d.destroyed, share: pctOf(d.destroyed), separatorAbove: true },
      { label: "Damaged", color: c.damaged, value: d.damaged, share: pctOf(d.damaged) },
    ];
    return (
      <TooltipCard header={d.date} minWidth={220}>
        <TooltipTable rows={rows} />
      </TooltipCard>
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
