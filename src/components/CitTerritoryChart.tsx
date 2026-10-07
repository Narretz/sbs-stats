import { Bar, Cell, Rectangle } from "recharts";
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
// one 48-hour figure, drawn as ONE bar spanning both its days at the
// daily-average height, so the bar's area is the report's real total — a
// histogram with one wider bin — and the tooltip quotes those totals. Two
// half-height bars would read as two measured days; a full-height bar on the
// Sunday would read as a spike with a hole before it.

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

  const daily = rows.length > 0 && isDaily(rows[0]);

  // A weekend's first day draws nothing and leaves its x behind; its second
  // day — the report's own date — draws one bar from there to its own right
  // edge. recharts renders a series' bars in data order, so the first day's
  // x is always recorded, in the same pass, before the second day reads it.
  // A weekend whose first day falls before the window has no recorded x and
  // draws as an ordinary single-day bar.
  const spanShape = (fill: string, radius: number) => {
    const firstDayX = new Map<string, number>();
    return (props: unknown) => {
      const { x, y, width, height, payload } =
        props as { x: number; y: number; width: number; height: number; payload: CitTerritoryDailyRow };
      const weekend = payload.window_days > 1 && payload.report_date != null;
      if (weekend && payload.date !== payload.report_date) {
        firstDayX.set(payload.report_date!, x);
        return <g />;
      }
      const left = weekend ? firstDayX.get(payload.date) ?? x : x;
      return (
        <Rectangle x={left} y={y} width={x + width - left} height={height}
                   radius={[radius, radius, 0, 0]}
                   fill={fill} />
      );
    };
  };

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
      subheader={caveat && (
        <div style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, marginBottom: 10 }}>{caveat}</div>
      )}
      legend={[
        { label: "Ukrainian-controlled", color: c.territoryUaControlled },
        { label: "Russian-controlled (occupied Ukraine + Russia)", color: c.territoryRuControlled },
      ]}
    >
      <Bar dataKey="uaControlled" stackId="a" name="Ukrainian-controlled" maxBarSize={MAX_BAR_SIZE}
           shape={daily ? spanShape(c.territoryUaControlled, 0) : undefined}>
        {!daily && rows.map((_, i) => <Cell key={`ua-${i}`} fill={c.territoryUaControlled} />)}
      </Bar>
      <Bar dataKey="ruControlled" stackId="a" name="Russian-controlled"
           radius={[3, 3, 0, 0]} maxBarSize={MAX_BAR_SIZE}
           shape={daily ? spanShape(c.territoryRuControlled, 3) : undefined}>
        {!daily && rows.map((_, i) => <Cell key={`ru-${i}`} fill={c.territoryRuControlled} />)}
      </Bar>
    </MonthlyChartCard>
  );
}

function shiftDay(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}
