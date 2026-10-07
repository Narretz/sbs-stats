import { Bar, Cell } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
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
// The daily page draws the same chart one bar per day. A weekend report is
// one 48-hour figure spread over its two days (utils/citTerritory.ts); those
// bars are drawn faded and the tooltip quotes the report's real totals, the
// way the headline daily charts flag the same days.

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

function formatDay(date: string): string {
  const [y, m, d] = date.split("-");
  return `${Number(d)} ${formatMonth(`${y}-${m}`).split(" ")[0]} ${y}`;
}

const dayTick = (v: string) => { const [, m, d] = v.split("-"); return `${d}/${m}`; };

// A spread weekend day is half of a whole number, so it can land on .5.
const fmtValue = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 10) / 10).toLocaleString();

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

  const label = (d: Row) => (isDaily(d) ? formatDay(d.date) : formatMonth(d.date));

  const describe = (d: Row): TooltipDescriptor => {
    if (d.uaControlled == null || d.ruControlled == null) {
      return { header: label(d), rows: [], emptyState: "No CIT report covers this day." };
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
    let footer: string | undefined;
    if (isDaily(d) && d.window_days > 1 && d.report_date) {
      const span = d.window_days;
      const first = dayTick(shiftDay(d.report_date, -(span - 1)));
      const whole = (v: number | null) => Math.round((v ?? 0) * span).toLocaleString();
      footer = `One ${span * 24}-hour weekend report covering ${first}–${dayTick(d.report_date)}: ` +
        `${whole(d.uaControlled)} Ukrainian-controlled, ${whole(d.ruControlled)} Russian-controlled in total. ` +
        `Shown here as a daily average \u2014 CIT did not publish a per-day split.`;
    }
    return { header: label(d), rows, footer, formatValue: fmtValue, minWidth: 260 };
  };

  const faded = (d: Row) => (isDaily(d) && d.window_days > 1 ? 0.55 : 1);

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
      tickFormatter={rows.length > 0 && isDaily(rows[0]) ? dayTick : undefined}
      showEmptyWrapper
      subheader={caveat && (
        <div style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, marginBottom: 10 }}>{caveat}</div>
      )}
      legend={[
        { label: "Ukrainian-controlled", color: c.territoryUaControlled },
        { label: "Russian-controlled (occupied Ukraine + Russia)", color: c.territoryRuControlled },
      ]}
    >
      <Bar dataKey="uaControlled" stackId="a" name="Ukrainian-controlled" maxBarSize={MAX_BAR_SIZE}>
        {rows.map((d, i) => <Cell key={`ua-${i}`} fill={c.territoryUaControlled} fillOpacity={faded(d)} />)}
      </Bar>
      <Bar dataKey="ruControlled" stackId="a" name="Russian-controlled"
           radius={[3, 3, 0, 0]} maxBarSize={MAX_BAR_SIZE}>
        {rows.map((d, i) => <Cell key={`ru-${i}`} fill={c.territoryRuControlled} fillOpacity={faded(d)} />)}
      </Bar>
    </MonthlyChartCard>
  );
}

function shiftDay(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}
