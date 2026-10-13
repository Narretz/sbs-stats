import { useEffect, useMemo, useState } from "react";
import { useCitCiviliansDatabaseContext } from "@/context/databases";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { useTheme } from "@/hooks/useTheme";
import { CitHeadlineChart, type CitMonthlyStackRow } from "@/components/CitHeadlineChart";
import { CitTerritoryChart } from "@/components/CitTerritoryChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { PageScaffold } from "@/components/PageScaffold";
import { ChartGrid } from "@/components/Layout";
import { padTrailingMonthly } from "@/utils/padTrailing";
import { projectCitMonth, stackTotal } from "@/utils/citTerritory";
import { maxMedian } from "@/utils/windowStats";
import { FONTS } from "@/theme";
import {
  CIT_METRIC_KEYS,
  type CitMetricKey,
  type CitMonthlyRow,
  type CitReconciliation,
  type CitTerritoryRow,
} from "@/types";

interface Props {
  refreshKey?: number;
}

export function CitCiviliansMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryTerritory,
          queryReconciliation, queryDataWindow } = useCitCiviliansDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const { allRows, rows, hasData, yr, allStats } = useMonthlyMetricGrid<CitMonthlyRow, CitMetricKey>({
    loadState, queryMonthly, refreshKey, keys: CIT_METRIC_KEYS, tz: "Europe/Moscow",
  });

  const [territory, setTerritory] = useState<CitTerritoryRow[]>([]);
  const [recon, setRecon] = useState<CitReconciliation>({
    reports: 0, bothExact: 0, killedExact: 0, killedDriftPct: 0, injuredDriftPct: 0,
  });
  useEffect(() => {
    if (loadState === "ready") {
      setTerritory(queryTerritory());
      setRecon(queryReconciliation());
    }
  }, [loadState, queryTerritory, queryReconciliation, refreshKey]);

  const endMonth = yr.endMonth;

  // Killed + injured, the month in progress projected from the days actually
  // covered by a report — see projectCitMonth. The month in progress only: a
  // past month with days no report covered is partial too, but finished.
  const stackRows = useMemo((): CitMonthlyStackRow[] =>
    padTrailingMonthly(
      rows.map((d) => {
        const killed = typeof d.killed === "number" ? d.killed : null;
        const injured = typeof d.injured === "number" ? d.injured : null;
        const covered = d.is_current_month ? d.covered_days : 0;
        const total = killed == null && injured == null ? null : (killed ?? 0) + (injured ?? 0);
        const p = projectCitMonth(d.date, total, covered);
        if (!p || total == null) return { date: d.date, killed, injured };
        return {
          date: d.date, killed, injured,
          projection: {
            killed: projectCitMonth(d.date, killed, covered)?.projected ?? null,
            injured: projectCitMonth(d.date, injured, covered)?.projected ?? null,
            total: p.projected, coveredDays: p.coveredDays, daysInMonth: p.daysInMonth,
          },
          projectedGap: p.projected - total,
        };
      }),
      endMonth,
      (date) => ({ date, killed: null, injured: null }),
    ), [rows, endMonth]);

  // The series' all-data stats, plus their sum's for the median line.
  const stackStats = useMemo(() => ({
    ...allStats,
    all: maxMedian(allRows.map((r) => r.killed + r.injured)),
  }), [allStats, allRows]);

  // Every month's, not the window's, for the "all" scope.
  const territoryStats = useMemo(() => ({
    all: maxMedian(territory.map((r) => stackTotal(r, ["uaControlled", "ruControlled"] as const))),
  }), [territory]);

  // The territory chart projects both bands together, on the same basis.
  const territoryRows = useMemo(() => {
    const covered = new Map(allRows.filter((r) => r.is_current_month).map((r) => [r.date, r.covered_days]));
    return yr.slice(territory).map((r) => {
      const p = projectCitMonth(r.date, r.uaControlled + r.ruControlled, covered.get(r.date) ?? 0);
      if (!p) return r;
      return {
        ...r,
        projection: { total: p.projected, coveredDays: p.coveredDays, daysInMonth: p.daysInMonth },
        projectedGap: p.projected - (r.uaControlled + r.ruControlled),
      };
    });
  }, [allRows, territory, yr]);

  const pct = (n: number) => Math.round((100 * n) / recon.reports);
  const drift = (v: number) => `${v >= 0 ? "+" : "\u2212"}${Math.abs(v).toFixed(1)}%`;

  return (
    <PageScaffold
      title="Monthly civilian casualties - CIT"
      description={<>Monthly sums of civilians killed and injured in Ukraine and Russia, compiled daily by the Conflict Intelligence Team from official statements · source: <a href="https://t.me/CIT_shellings" rel="nofollow external" target="_blank">@CIT_shellings</a>. Months are keyed by each report's window end date.</>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="cit" />}
      controls={yr.hidden ? undefined : (
        <>
          <MonthWindowControls yr={yr} min={allRows[0]?.date ?? ""} />
          <StatScopeToggle />
        </>
      )}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading CIT civilian-casualties database…"
    >
      <ChartGrid>
        <CitTerritoryChart data={territoryRows} granularity="monthly" globalStats={territoryStats} wfull />
      </ChartGrid>

      <p style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 1.6, color: t.textMuted, margin: "18px 2px 10px" }}>
        The split above sums killed and injured together, since the question it
        answers is <i>where</i> rather than <i>how</i>, and keeps occupied and
        government-held parts of the same oblast apart, because they are
        different places. It is a <b style={{ color: t.text }}>secondary</b>{" "}
        reading of each report's per-region lines; the chart below is each
        report's own headline — the total CIT states in its closing sentence.
        {recon.reports > 0 && (
          <>
            {" "}Across {recon.reports.toLocaleString()} reports the split's{" "}
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
      </p>
      <ChartGrid>
        <CitHeadlineChart title="All civilian casualties" data={stackRows} granularity="monthly" globalStats={stackStats} wfull />
      </ChartGrid>
    </PageScaffold>
  );
}
