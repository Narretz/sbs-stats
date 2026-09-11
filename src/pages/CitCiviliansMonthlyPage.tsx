import { useEffect, useMemo, useState } from "react";
import { useCitCiviliansDatabaseContext } from "@/context/databases";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { CitRegionTable } from "@/components/CitRegionTable";
import { CitTerritoryChart } from "@/components/CitTerritoryChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { ChartGrid } from "@/components/Layout";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { FONTS } from "@/theme";
import {
  CIT_METRIC_KEYS,
  CIT_METRIC_LABELS,
  type CitMetricKey,
  type CitMonthlyRow,
  type CitReconciliation,
  type CitRegionRow,
  type CitTerritoryRow,
  type MonthlyDataPoint,
} from "@/types";

interface Props {
  refreshKey?: number;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export function CitCiviliansMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryRegions, queryTerritory,
          queryReconciliation, queryDataWindow } = useCitCiviliansDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const { rows, hasData, yr, allStats } = useMonthlyMetricGrid<CitMonthlyRow, CitMetricKey>({
    loadState, queryMonthly, refreshKey, keys: CIT_METRIC_KEYS,
  });

  const [regions, setRegions] = useState<CitRegionRow[]>([]);
  const [territory, setTerritory] = useState<CitTerritoryRow[]>([]);
  const [recon, setRecon] = useState<CitReconciliation>({
    reports: 0, bothExact: 0, killedExact: 0, killedDriftPct: 0, injuredDriftPct: 0,
  });
  useEffect(() => {
    if (loadState === "ready") {
      setRegions(queryRegions());
      setTerritory(queryTerritory());
      setRecon(queryReconciliation());
    }
  }, [loadState, queryRegions, queryTerritory, queryReconciliation, refreshKey]);

  const endMonth = resolvedEndMonth("Europe/Moscow");

  // A month is projected from the days actually covered by a report, not from
  // today's date: CIT can be a day or two behind, and a weekend post covers two
  // days at once, so "day 9 of 30" is the wrong denominator. `covered_days`
  // knows what was really reported.
  const makeDataset = (key: CitMetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
      rows.map((d) => {
        const value = typeof d[key] === "number" ? d[key] : null;
        const total = daysInMonth(d.date);
        const partial = d.covered_days > 0 && d.covered_days < total;
        const projected =
          partial && value != null ? Math.round((value * total) / d.covered_days) : undefined;
        return {
          date: d.date,
          value,
          gap: projected != null && value != null ? projected - value : undefined,
          projected,
          projection_day: partial ? d.covered_days : undefined,
          projection_days_in_month: partial ? total : undefined,
        };
      }),
      endMonth,
    );

  const pct = (n: number) => Math.round((100 * n) / recon.reports);
  const drift = (v: number) => `${v >= 0 ? "+" : "\u2212"}${Math.abs(v).toFixed(1)}%`;

  return (
    <PageScaffold
      title="Monthly civilian casualties - CIT"
      description={<>Monthly sums of civilians killed and injured in Ukraine and Russia, compiled daily by the Conflict Intelligence Team from official statements · source: <a href="https://t.me/CIT_shellings" rel="nofollow external" target="_blank">@CIT_shellings</a>. Months are keyed by each report's window end date.</>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="cit" />}
      controls={yr.hidden ? undefined : (
        <>
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
          <StatScopeToggle />
        </>
      )}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading CIT civilian-casualties database…"
    >
      <ChartGrid>
        {CIT_METRIC_KEYS.map((k) => (
          <MonthlyBarChart
            key={k}
            title={CIT_METRIC_LABELS[k]}
            data={makeDataset(k)}
            wfull={false}
            globalMax={allStats[k]?.max ?? 0}
            globalMedian={allStats[k]?.median ?? 0}
            globalTotal={allStats[k]?.total ?? 0}
          />
        ))}
      </ChartGrid>

      <p style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 1.6, color: t.textMuted, margin: "18px 2px 10px" }}>
        The figures above are each report's own headline — the total CIT states
        in its closing sentence. The regional split below is a{" "}
        <b style={{ color: t.text }}>secondary</b> reading of the same posts.
        {recon.reports > 0 && (
          <>
            {" "}Across {recon.reports.toLocaleString()} reports its{" "}
            <b style={{ color: t.text }}>killed</b> column matches that headline
            exactly {pct(recon.killedExact)}% of the time and both columns match{" "}
            {pct(recon.bothExact)}% of the time, while the totals land within{" "}
            {drift(recon.killedDriftPct)} (killed) and {drift(recon.injuredDriftPct)}{" "}
            (injured) of the stated figures overall.
          </>
        )}{" "}
        So the split is good to about a percent in aggregate but rarely exact on
        any one day — older posts describe casualties in free prose, and some
        posts simply disagree with themselves. Read it as a shape, not a count.
        Both views below sum killed and injured together, since the question
        they answer is <i>where</i> rather than <i>how</i>, and both keep
        occupied and government-held parts of the same oblast apart, because
        they are different places.
      </p>
      <ChartGrid>
        <CitTerritoryChart data={yr.slice(territory)} wfull />
        <CitRegionTable rows={regions} />
      </ChartGrid>
    </PageScaffold>
  );
}
