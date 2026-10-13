import { Bar } from "recharts";
import { styledBar } from "@/components/barShape";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import type { SheetSource, TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";

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
  // The primary source behind each month ("YYYY-MM"), linked in the pinned
  // sheet only — see TooltipDescriptor.sources.
  sourcesByDate?: Map<string, SheetSource[]>;
}

// Same cap as MonthlyBarChart — keeps few-bar charts from rendering absurdly fat.
const MAX_BAR_SIZE = 70;

export function TargetsStackedChart({ title, data, wfull, sourcesByDate }: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const lastIdx = data.length - 1;

  const describe = (d: TargetsStackPoint): TooltipDescriptor => {
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
    return { header: d.date, rows, minWidth: 220, sources: sourcesByDate?.get(d.date.slice(0, 7)) };
  };

  // `destroyed` on the bottom (the "permanent" half), `damaged` on top —
  // reading bottom-up matches "fully neutralised → partially neutralised".
  return (
    <MonthlyChartCard
      title={title}
      data={data}
      wfull={wfull}
      describe={describe}
      legend={[
        { label: "Destroyed", color: c.destroyed },
        { label: "Damaged", color: c.damaged },
      ]}
    >
      <Bar dataKey="destroyed" stackId="a" name="Destroyed" maxBarSize={MAX_BAR_SIZE}
        shape={styledBar((_, i) => ({ fill: i === lastIdx ? c.destroyedCurrent : c.destroyed }))} />
      <Bar dataKey="damaged" stackId="a" name="Damaged" maxBarSize={MAX_BAR_SIZE}
        shape={styledBar((_, i) => ({ fill: i === lastIdx ? c.barCurrent : c.damaged }))} />
    </MonthlyChartCard>
  );
}
