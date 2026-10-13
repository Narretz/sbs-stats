import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { CitStackedChart } from "@/components/CitStackedChart";
import type { SheetSource, TooltipTableRow } from "@/components/TooltipTable";
import type { ReactNode } from "react";
import type { CitKilledInjured, CitTerritoryDailyRow, CitTerritoryRow, Stat } from "@/types";
import { scaleOutcomes } from "@/utils/citTerritory";

// Where civilians are being hurt, month by month: killed and injured summed
// (the question is the place, not the outcome), split by which side holds the
// ground. Part-to-whole over time → stacked bars.
//
// Two bands, because that is the split that means something — but Russian-
// controlled is two near-equal halves, occupied Ukraine and Russia proper, so
// the tooltip breaks it out rather than letting one number hide the other.
//
// Drawn by CitStackedChart, like the headline chart: on the daily page one
// bar per day, a weekend report ONE bar spanning both its days; the tooltip
// quotes the report's real totals.

type Row = CitTerritoryRow | CitTerritoryDailyRow;
type Band = "uaControlled" | "ruControlled";

function isDaily(d: Row): d is CitTerritoryDailyRow {
  return "window_days" in d;
}

export function CitTerritoryChart({ data, granularity, globalStats, wfull, caveat, sourcesByDate }: {
  data: CitTerritoryRow[] | CitTerritoryDailyRow[];
  granularity: "daily" | "monthly";
  // The all-data stat of the two bands' sum, for the median line in the "all"
  // scope.
  globalStats?: Partial<Record<Band | "all", Stat>>;
  wfull?: boolean;
  // A line under the legend, for a page that has no room for the monthly
  // page's paragraph on how far the breakdown can be trusted.
  caveat?: ReactNode;
  // Each day's report post, linked in the pinned sheet (daily page).
  sourcesByDate?: Map<string, SheetSource[]>;
}) {
  const { theme: t } = useTheme();
  const c = chartColors(t);

  // A weekend report's days describe the report itself, at its real 48-hour
  // figures — the same entry from either day.
  //
  // The bars draw killed + injured; the tooltip splits each part back into
  // the two. Like the bars, these are the parsed region rows, so they need not
  // match the headline killed / injured charts on a given day.
  const describe = (row: Row) => {
    if (row.outcomes == null) {
      // A footer rather than `emptyState`, which only the pinned sheet shows:
      // on hover too, an uncovered day has to say it is a gap, not a quiet day.
      return { rows: [], footer: "No CIT report covers this day." };
    }
    const span = isDaily(row) ? row.window_days : 1;
    // Whole numbers again: a weekend day carries half of each figure.
    const o = scaleOutcomes(row.outcomes, span);
    const add = (...xs: CitKilledInjured[]): CitKilledInjured =>
      xs.reduce((a, x) => ({ killed: a.killed + x.killed, injured: a.injured + x.injured }), { killed: 0, injured: 0 });
    const ruControlled = add(o.occupiedUkraine, o.russia);
    const all = add(o.uaControlled, ruControlled);
    const total = all.killed + all.injured;
    const line = (label: string, color: string, v: CitKilledInjured, extra: Partial<TooltipTableRow> = {}): TooltipTableRow => {
      const n = v.killed + v.injured;
      return {
        label, color, value: n, extra: [v.killed, v.injured],
        share: total > 0 ? (n / total) * 100 : null, ...extra,
      };
    };
    const med = !isDaily(row) ? row.dailyMedian : undefined;
    const rows: TooltipTableRow[] = [
      {
        ...line("Total", t.text, all, { emphasis: "bold" }), share: null,
        projected: !isDaily(row) ? (row.projection?.total ?? null) : null,
        dailyMedian: med?.total ?? null,
      },
      line("Ukrainian-controlled", c.territoryUaControlled, o.uaControlled, { separatorAbove: true, dailyMedian: med?.uaControlled ?? null }),
      line("Russian-controlled", c.territoryRuControlled, ruControlled, { dailyMedian: med?.ruControlled ?? null }),
      // The halves of the band above, indented by their labels rather than by
      // layout — the table has no nesting, and inventing one here would cost
      // more than it explains.
      line("— occupied Ukraine", t.textMuted, o.occupiedUkraine, { dailyMedian: med?.occupiedUkraine ?? null }),
      line("— Russia", t.textMuted, o.russia, { dailyMedian: med?.russia ?? null }),
    ];
    const unrec = o.unattributed;
    if (unrec.killed + unrec.injured > 0) {
      rows.push({ ...line("Region unrecognised", t.textMuted, unrec, { separatorAbove: true }), share: null });
    }
    const footer = span > 1
      ? `One ${span * 24}-hour report. Drawn across its ${span} days at the daily average.`
      : undefined;
    return { rows, footer, minWidth: 340, extraColumns: ["Killed", "Injured"] };
  };

  // Ukrainian-controlled on the bottom: it is ~73% of the total, so putting it
  // at the baseline keeps the smaller band's own variation readable along a
  // flat edge instead of riding on a much larger one.
  return (
    <CitStackedChart<Band, Row>
      title="Casualties by controlling side"
      data={data}
      granularity={granularity}
      series={[
        { key: "uaControlled", label: "Ukrainian-controlled", color: c.territoryUaControlled },
        { key: "ruControlled", label: "Russian-controlled (occupied Ukraine + Russia)", color: c.territoryRuControlled },
      ]}
      describe={describe}
      header="legend"
      totalLabel="BOTH SIDES"
      globalStats={globalStats}
      caveat={caveat}
      wfull={wfull}
      sourcesByDate={sourcesByDate}
    />
  );
}
