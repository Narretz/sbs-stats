import { useMemo, useEffect, useState } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyYearRange } from "@/hooks/useMonthlyYearRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { MonthlyTargetPairChart, type MonthlyTargetPairDataPoint } from "@/components/MonthlyTargetPairChart";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { YearRangeSelect } from "@/components/YearRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import { TARGET_IDS, TARGET_LABELS } from "@/types";
import type { MonthlyDataPoint, MonthlyRow, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";

interface MonthlyPageProps {
  refreshKey?: number;
}

export function SbsMonthlyPage({ refreshKey }: MonthlyPageProps) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryDataWindow } = useDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [allRows, setAllRows] = useState<MonthlyRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const yr = useMonthlyYearRange(allRows.length);
  const rows = useMemo(() => yr.slice(allRows), [allRows, yr]);

  useEffect(() => {
    if (loadState === "ready") { setAllRows(queryMonthly()); setHasData(true); }
  }, [loadState, queryMonthly, refreshKey]);

  const metrics = useMemo<Metric[]>(() => buildMetrics(), []);
  const baseMetrics = useMemo<Metric[]>(
    () => metrics.filter((m) =>
      !/^((hit|destroyed)_\d+)$/.test(String(m.key))
      && m.key !== "personnel_killed"
      && m.key !== "personnel_wounded"
      && m.key !== "total_targets_hit"
      && m.key !== "total_targets_destroyed"
    ),
    [metrics]
  );

  // Whole-dataset stats per metric, computed off the un-sliced rows so the
  // "all" stat scope reflects everything ever published — not just what the
  // current year-range filter keeps. Window scope uses the sliced/padded data
  // and is computed inside the chart components.
  const allStats = useMemo(() => {
    const out: Record<string, { max: number; median: number; total: number }> = {};
    for (const r of allRows) {
      for (const k of Object.keys(r)) {
        const v = (r as Record<string, unknown>)[k];
        if (typeof v !== "number") continue;
        (out[k] ??= { max: 0, median: 0, total: 0 });
      }
    }
    for (const k of Object.keys(out)) {
      out[k] = maxMedian(allRows.map((r) => {
        const v = (r as Record<string, unknown>)[k];
        return typeof v === "number" ? v : null;
      }));
    }
    return out;
  }, [allRows]);

  const endMonth = resolvedEndMonth();
  const makeDataset = (key: StatKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
      rows.map((d: MonthlyRow) => {
        const value = typeof d[key] === "number" ? (d[key] as number) : null;
        const projected = d[`${key}_projected`] as number | undefined;
        return {
          date: d.date, value,
          gap: projected != null && value != null ? projected - value : undefined,
          projected,
          projection_day: d.projection_day ?? undefined,
          projection_days_in_month: d.projection_days_in_month ?? undefined,
        };
      }),
      endMonth,
    );

  const makeTargetPairDataset = (targetId: number): MonthlyTargetPairDataPoint[] =>
    rows.map((d: MonthlyRow) => {
      const hitKey = `hit_${targetId}` as StatKey;
      const destroyedKey = `destroyed_${targetId}` as StatKey;
      const hitValue = (d[hitKey] as number) ?? 0;
      const hitProjected = d[`${hitKey}_projected`] as number | undefined;
      const destroyedValue = (d[destroyedKey] as number) ?? 0;
      const destroyedProjected = d[`${destroyedKey}_projected`] as number | undefined;
      return {
        date: d.date,
        hit_value: hitValue,
        hit_gap: hitProjected != null ? hitProjected - hitValue : undefined,
        hit_projected: hitProjected,
        destroyed_value: destroyedValue,
        destroyed_gap: destroyedProjected != null ? destroyedProjected - destroyedValue : undefined,
        destroyed_projected: destroyedProjected,
        projection_day: d.projection_day ?? undefined,
        projection_days_in_month: d.projection_days_in_month ?? undefined,
      };
    });

  const makePersonnelPairDataset = (): MonthlyTargetPairDataPoint[] =>
    rows.map((d: MonthlyRow) => {
      const hitValue = (d["total_personnel_casualties"] as number) ?? 0;
      const hitProjected = d["total_personnel_casualties_projected"] as number | undefined;
      const killedValue = (d["personnel_killed"] as number) ?? 0;
      const killedProjected = d["personnel_killed_projected"] as number | undefined;
      return {
        date: d.date,
        hit_value: hitValue,
        hit_gap: hitProjected != null ? hitProjected - hitValue : undefined,
        hit_projected: hitProjected,
        destroyed_value: killedValue,
        destroyed_gap: killedProjected != null ? killedProjected - killedValue : undefined,
        destroyed_projected: killedProjected,
        projection_day: d.projection_day ?? undefined,
        projection_days_in_month: d.projection_days_in_month ?? undefined,
      };
    });

  const makeTargetsPairDataset = (): MonthlyTargetPairDataPoint[] =>
    rows.map((d: MonthlyRow) => {
      const hitValue = (d["total_targets_hit"] as number) ?? 0;
      const hitProjected = d["total_targets_hit_projected"] as number | undefined;
      const destroyedValue = (d["total_targets_destroyed"] as number) ?? 0;
      const destroyedProjected = d["total_targets_destroyed_projected"] as number | undefined;
      return {
        date: d.date,
        hit_value: hitValue,
        hit_gap: hitProjected != null ? hitProjected - hitValue : undefined,
        hit_projected: hitProjected,
        destroyed_value: destroyedValue,
        destroyed_gap: destroyedProjected != null ? destroyedProjected - destroyedValue : undefined,
        destroyed_projected: destroyedProjected,
        projection_day: d.projection_day ?? undefined,
        projection_days_in_month: d.projection_days_in_month ?? undefined,
      };
    });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexDirection: 'column', marginBottom: 28 }}>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            UA SBS Monthly Statistics
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Syly bezpilotnykh system / Unmannend System Force (SBS/USF) · Monthly aggregates - current month shows end-of-month projection. · From <a href="noreferer nofollow">https://sbs-group.army/</a>
          </p>
          <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="sbs" />
        <div style={{ display: "flex", gap: 20, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
          <span style={{ color: t.primary }}>Hit</span>
          <span style={{ color: t.accent }}>Destroyed</span>
          <span style={{ color: t.textMuted }}>Lighter segment = current-month projection</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {!yr.hidden && (
            <YearRangeSelect options={yr.yearOptions} value={yr.years} onChange={yr.setYears} />
          )}
          <StatScopeToggle />
        </div>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {baseMetrics.map((m: Metric) => (
            <MonthlyBarChart
              key={m.key}
              title={m.label}
              data={makeDataset(m.key)}
              wfull={m.wfull ?? false}
              globalMax={allStats[m.key]?.max ?? 0}
              globalMedian={allStats[m.key]?.median ?? 0}
              globalTotal={allStats[m.key]?.total ?? 0}
            />
          ))}
          <MonthlyTargetPairChart
            key="personnel-killed-wounded"
            title="Personnel Hit / Killed"
            data={makePersonnelPairDataset()}
            primaryLabel="Hit"
            secondaryLabel="Killed"
            showRatio={true}
            ratioLabel="% killed"
            globalMax={allStats["total_personnel_casualties"]?.max ?? 0}
            globalMedian={allStats["total_personnel_casualties"]?.median ?? 0}
            globalTotal={allStats["total_personnel_casualties"]?.total ?? 0}
            globalMax2={allStats["personnel_killed"]?.max ?? 0}
            globalMedian2={allStats["personnel_killed"]?.median ?? 0}
            globalTotal2={allStats["personnel_killed"]?.total ?? 0}
          />
          <MonthlyTargetPairChart
            key="targets-hit-destroyed"
            title="Targets Hit / Destroyed"
            data={makeTargetsPairDataset()}
            globalMax={allStats["total_targets_hit"]?.max ?? 0}
            globalMedian={allStats["total_targets_hit"]?.median ?? 0}
            globalTotal={allStats["total_targets_hit"]?.total ?? 0}
            globalMax2={allStats["total_targets_destroyed"]?.max ?? 0}
            globalMedian2={allStats["total_targets_destroyed"]?.median ?? 0}
            globalTotal2={allStats["total_targets_destroyed"]?.total ?? 0}
          />
          {TARGET_IDS.map((targetId) => (
            <MonthlyTargetPairChart
              key={`target-pair-${targetId}`}
              title={TARGET_LABELS[targetId]}
              data={makeTargetPairDataset(targetId)}
              globalMax={allStats[`hit_${targetId}`]?.max ?? 0}
              globalMedian={allStats[`hit_${targetId}`]?.median ?? 0}
              globalTotal={allStats[`hit_${targetId}`]?.total ?? 0}
              globalMax2={allStats[`destroyed_${targetId}`]?.max ?? 0}
              globalMedian2={allStats[`destroyed_${targetId}`]?.median ?? 0}
              globalTotal2={allStats[`destroyed_${targetId}`]?.total ?? 0}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
