import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { fmtCount, type SpannedDay } from "@/components/spanBarShape";
import { CitStackedChart, type CitStackRowBase, type CitStackSeries } from "@/components/CitStackedChart";
import type { TooltipTableRow } from "@/components/TooltipTable";
import { CIT_METRIC_KEYS, CIT_METRIC_LABELS, type CitMetricKey, type Stat } from "@/types";

// CIT's headline figures — the total each report states in its closing
// sentence — killed + injured stacked, on the daily page one bar per day and
// on the monthly page one per month. Killed sits at the bottom, anchored to
// the baseline, which is the only place a band that small stays readable
// against an injured count roughly six times larger.

// One day of the headline series. A weekend report's two days each carry half
// of it; a day no report covers carries nulls.
export interface CitDailyBarRow extends SpannedDay {
  killed: number | null;
  injured: number | null;
}

// One month. The month in progress carries each series' projection
// (projectCitMonth) and the total's, which the chart stacks on top.
export interface CitMonthlyStackRow extends CitStackRowBase {
  killed: number | null;
  injured: number | null;
  projection?: {
    killed: number | null;
    injured: number | null;
    total: number;
    coveredDays: number;
    daysInMonth: number;
  };
}

type Row = CitDailyBarRow | CitMonthlyStackRow;

interface Props {
  title: string;
  data: CitDailyBarRow[] | CitMonthlyStackRow[];
  granularity: "daily" | "monthly";
  // Whole-dataset stats per series and for their sum (`all`), for the "all"
  // scope — daily on the same per-day basis as the bars (a weekend counted as
  // two half days).
  globalStats: Partial<Record<CitMetricKey | "all", Stat>>;
  wfull?: boolean;
}

const isDaily = (d: Row): d is CitDailyBarRow => "window_days" in d;

export function CitHeadlineChart({ title, data, granularity, globalStats, wfull }: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const color: Record<CitMetricKey, string> = {
    killed: c.civiliansKilled,
    injured: c.civiliansInjured,
  };
  const series: CitStackSeries<CitMetricKey>[] = CIT_METRIC_KEYS.map((k) => ({
    key: k, label: CIT_METRIC_LABELS[k], color: color[k],
  }));

  // Daily, one description per ENTRY: both days of a weekend report describe
  // the report itself, at its real 48-hour figures. Only the bar height is the
  // average.
  const describe = (d: Row) => {
    if (isDaily(d) && d.report_date == null) {
      return { rows: [], footer: "No CIT report covers this day." };
    }
    const span = isDaily(d) ? d.window_days : 1;
    const whole = (v: number | null) => (v == null ? null : Math.round(v * span));
    const p = isDaily(d) ? undefined : d.projection;
    const total = d.killed == null && d.injured == null ? null : (whole(d.killed) ?? 0) + (whole(d.injured) ?? 0);
    // Top of the stack first, as it reads on the chart.
    const rows: TooltipTableRow[] = [
      { label: "Total", color: t.text, value: total, emphasis: "bold", projected: p?.total ?? null },
      ...[...CIT_METRIC_KEYS].reverse().map((k, i) => ({
        label: CIT_METRIC_LABELS[k], color: color[k], value: whole(d[k]),
        projected: p?.[k] ?? null, separatorAbove: i === 0,
      })),
    ];
    const footer = span > 1
      ? `One ${span * 24}-hour weekend report. Drawn across its ${span} days at the ` +
        `daily average (${CIT_METRIC_KEYS.map((k) => `${fmtCount(d[k] ?? 0)} ${k}`).join(", ")} a day) ` +
        `— CIT did not publish a per-day split.`
      : undefined;
    return { rows, footer, minWidth: 240 };
  };

  return (
    <CitStackedChart<CitMetricKey, Row>
      title={title}
      data={data}
      granularity={granularity}
      series={series}
      describe={describe}
      header="stats"
      totalLabel="KILLED + INJURED"
      globalStats={globalStats}
      wfull={wfull}
    />
  );
}
