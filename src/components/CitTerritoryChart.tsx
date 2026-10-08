import { Bar, Cell } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import { dayTick, entryOfDay, fmtCount, formatEntry, spanBarShape } from "@/components/spanBarShape";
import { SpanCursor } from "@/components/SpanCursor";
import type { TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";
import type { ReactNode } from "react";
import type { CitTerritoryDailyRow, CitTerritoryRow } from "@/types";

// Where civilians are being hurt, month by month: killed and injured summed
// (the question is the place, not the outcome), split by which side holds the
// ground. Part-to-whole over time → stacked bars.
//
// Two bands, because that is the split that means something — but Russian-
// controlled is two near-equal halves, occupied Ukraine and Russia proper, so
// the tooltip breaks it out rather than letting one number hide the other.
//
// The daily page draws the same chart one bar per day, with a weekend report
// as ONE bar spanning both its days (spanBarShape, shared with the headline
// charts in CitDailyBarChart); the tooltip quotes the report's real totals.

const MAX_BAR_SIZE = 70;

function formatMonth(date: string): string {
  const [y, m] = date.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1]} ${y}`;
}

type Row = CitTerritoryRow | CitTerritoryDailyRow;

function isDaily(d: Row): d is CitTerritoryDailyRow {
  return "window_days" in d;
}

export function CitTerritoryChart({ data, wfull, caveat }: {
  data: CitTerritoryRow[] | CitTerritoryDailyRow[];
  wfull?: boolean;
  // A line under the legend, for a page that has no room for the monthly
  // page's paragraph on how far the breakdown can be trusted.
  caveat?: ReactNode;
}) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const rows: Row[] = data;

  const label = (d: Row) => (isDaily(d) ? formatEntry(d) : formatMonth(d.date));

  // A weekend report's days describe the report itself, at its real 48-hour
  // figures — the same entry from either day (see CitDailyBarChart).
  const describe = (row: Row): TooltipDescriptor => {
    const span = isDaily(row) ? row.window_days : 1;
    const whole = (v: number | null) => (v == null ? null : Math.round(v * span));
    const d = span > 1 ? {
      ...row,
      uaControlled: whole(row.uaControlled), ruControlled: whole(row.ruControlled),
      occupiedUkraine: whole(row.occupiedUkraine), russia: whole(row.russia),
      unattributed: whole(row.unattributed),
    } : row;
    if (d.uaControlled == null || d.ruControlled == null) {
      // A footer rather than `emptyState`, which only the pinned sheet shows:
      // on hover too, an uncovered day has to say it is a gap, not a quiet day.
      return { header: label(row), rows: [], footer: "No CIT report covers this day." };
    }
    const total = d.uaControlled + d.ruControlled;
    const share = (v: number | null) => (v != null && total > 0 ? (v / total) * 100 : null);
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
    if (d.unattributed != null && d.unattributed > 0) {
      rows.push({
        label: "Region unrecognised", color: t.textMuted, value: d.unattributed,
        separatorAbove: true,
      });
    }
    const footer = span > 1
      ? `One ${span * 24}-hour weekend report. Drawn across its ${span} days at the daily ` +
        `average \u2014 CIT did not publish a per-day split.`
      : undefined;
    return { header: label(row), rows, footer, formatValue: fmtCount, minWidth: 260 };
  };

  const daily = rows.length > 0 && isDaily(rows[0]);

  // Ukrainian-controlled on the bottom: it is ~73% of the total, so putting it
  // at the baseline keeps the smaller band's own variation readable along a
  // flat edge instead of riding on a much larger one.
  return (
    <MonthlyChartCard<Row>
      title="Casualties by controlling side"
      data={rows}
      wfull={wfull}
      describe={describe}
      // The hover card formats the date, so the sheet's stepper must too —
      // one description rendered two ways is the point of the descriptor, and
      // "Mar 2026" above a stepper reading "2026-03" would undo it.
      formatLabel={label}
      tickFormatter={daily ? dayTick : undefined}
      showEmptyWrapper
      entryOf={daily ? (d) => entryOfDay(d as CitTerritoryDailyRow) : undefined}
      cursor={daily ? <SpanCursor rows={rows as CitTerritoryDailyRow[]} /> : undefined}
      subheader={caveat && (
        <div style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, marginBottom: 10 }}>{caveat}</div>
      )}
      legend={[
        { label: "Ukrainian-controlled", color: c.territoryUaControlled },
        { label: "Russian-controlled (occupied Ukraine + Russia)", color: c.territoryRuControlled },
      ]}
    >
      <Bar dataKey="uaControlled" stackId="a" name="Ukrainian-controlled" maxBarSize={MAX_BAR_SIZE}
           shape={daily ? spanBarShape(c.territoryUaControlled) : undefined}>
        {!daily && rows.map((_, i) => <Cell key={`ua-${i}`} fill={c.territoryUaControlled} />)}
      </Bar>
      <Bar dataKey="ruControlled" stackId="a" name="Russian-controlled"
           maxBarSize={MAX_BAR_SIZE}
           shape={daily ? spanBarShape(c.territoryRuControlled) : undefined}>
        {!daily && rows.map((_, i) => <Cell key={`ru-${i}`} fill={c.territoryRuControlled} />)}
      </Bar>
    </MonthlyChartCard>
  );
}

