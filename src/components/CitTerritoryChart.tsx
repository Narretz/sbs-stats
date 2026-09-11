import { Bar, Cell } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import type { TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";
import type { CitTerritoryRow } from "@/types";

// Where civilians are being hurt, month by month: killed and injured summed
// (the question is the place, not the outcome), split by which side holds the
// ground. Part-to-whole over time → stacked bars.
//
// Two bands, because that is the split that means something — but Russian-
// controlled is two near-equal halves, occupied Ukraine and Russia proper, so
// the tooltip breaks it out rather than letting one number hide the other.

const MAX_BAR_SIZE = 70;

function formatMonth(date: string): string {
  const [y, m] = date.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1]} ${y}`;
}

export function CitTerritoryChart({ data, wfull }: { data: CitTerritoryRow[]; wfull?: boolean }) {
  const { theme: t } = useTheme();
  const c = chartColors(t);

  const describe = (d: CitTerritoryRow): TooltipDescriptor => {
    const total = d.uaControlled + d.ruControlled;
    const share = (v: number) => (total > 0 ? (v / total) * 100 : null);
    const rows: TooltipTableRow[] = [
      { label: "Total", color: t.text, value: total, emphasis: "bold" },
      { label: "Ukrainian-controlled", color: c.territoryUaControlled,
        value: d.uaControlled, share: share(d.uaControlled), separatorAbove: true },
      { label: "Russian-controlled", color: c.territoryRuControlled,
        value: d.ruControlled, share: share(d.ruControlled) },
      // The halves of the band above, indented by their labels rather than by
      // layout — the table has no nesting, and inventing one here would cost
      // more than it explains.
      { label: "— occupied Ukraine", color: t.textMuted,
        value: d.occupiedUkraine, share: share(d.occupiedUkraine) },
      { label: "— Russia", color: t.textMuted,
        value: d.russia, share: share(d.russia) },
    ];
    if (d.unattributed > 0) {
      rows.push({
        label: "Region unrecognised", color: t.textMuted, value: d.unattributed,
        separatorAbove: true,
      });
    }
    return { header: formatMonth(d.date), rows, minWidth: 260 };
  };

  // Ukrainian-controlled on the bottom: it is ~73% of the total, so putting it
  // at the baseline keeps the smaller band's own variation readable along a
  // flat edge instead of riding on a much larger one.
  return (
    <MonthlyChartCard
      title="Casualties by controlling side"
      data={data}
      wfull={wfull}
      describe={describe}
      // The hover card formats the month, so the sheet's stepper must too —
      // one description rendered two ways is the point of the descriptor, and
      // "Mar 2026" above a stepper reading "2026-03" would undo it.
      formatLabel={(d) => formatMonth(d.date)}
      legend={[
        { label: "Ukrainian-controlled", color: c.territoryUaControlled },
        { label: "Russian-controlled (occupied Ukraine + Russia)", color: c.territoryRuControlled },
      ]}
    >
      <Bar dataKey="uaControlled" stackId="a" name="Ukrainian-controlled" maxBarSize={MAX_BAR_SIZE}>
        {data.map((_, i) => <Cell key={`ua-${i}`} fill={c.territoryUaControlled} />)}
      </Bar>
      <Bar dataKey="ruControlled" stackId="a" name="Russian-controlled"
           radius={[3, 3, 0, 0]} maxBarSize={MAX_BAR_SIZE}>
        {data.map((_, i) => <Cell key={`ru-${i}`} fill={c.territoryRuControlled} />)}
      </Bar>
    </MonthlyChartCard>
  );
}
