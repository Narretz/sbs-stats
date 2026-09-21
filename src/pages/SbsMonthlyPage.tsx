import { useCallback, useEffect, useMemo, useState } from "react";
import { SUBSET_LABEL } from "@/tooltipLabels";
import { useSbsDatabaseContext, useSbsUnitsDatabaseContext } from "@/context/databases";
import { UnitSelect } from "@/components/UnitSelect";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { MonthlyTargetPairChart, type MonthlyTargetPairDataPoint } from "@/components/MonthlyTargetPairChart";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { buildMetrics } from "@/utils/metrics";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import { SBS_UNIT_ALL, TARGET_IDS, TARGET_LABELS, sbsUnitLabel } from "@/types";
import type { MonthlyDataPoint, MonthlyRow, StatKey, Metric } from "@/types";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";

interface MonthlyPageProps {
  refreshKey?: number;
}

// The selected unit lives in the URL so a view is linkable
// (`?site=sbs&page=monthly&unit=fenix`). Picking a unit is a filter, not a
// navigation, so it replaces the entry rather than pushing one — the same rule
// the homepage and compare page use for their own params.
function readUnitFromUrl(): string {
  return new URLSearchParams(window.location.search).get("unit") || SBS_UNIT_ALL;
}

function writeUnitToUrl(slug: string): void {
  const p = new URLSearchParams(window.location.search);
  if (slug === SBS_UNIT_ALL) p.delete("unit");
  else p.set("unit", slug);
  const qs = p.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
}

export function SbsMonthlyPage({ refreshKey }: MonthlyPageProps) {
  const { theme: t } = useTheme();
  const grouping = useSbsDatabaseContext();
  const units = useSbsUnitsDatabaseContext();

  const [unit, setUnit] = useState<string>(readUnitFromUrl);
  const isAll = unit === SBS_UNIT_ALL;

  const unitList = useMemo(
    () => (units.loadState === "ready" ? units.queryUnits() : []),
    [units],
  );

  // A `unit=` naming something the registry doesn't have — a typo, or a slug
  // that moved — falls back to the grouping rather than rendering an empty
  // page. Deferred until the registry is loaded, or it would fire on every
  // first paint.
  useEffect(() => {
    if (isAll || !unitList.length) return;
    if (!unitList.some((u) => u.slug === unit)) setUnit(SBS_UNIT_ALL);
  }, [isAll, unit, unitList]);

  useEffect(() => { writeUnitToUrl(unit); }, [unit]);

  const selected = useMemo(
    () => (isAll ? null : unitList.find((u) => u.slug === unit) ?? null),
    [isAll, unit, unitList],
  );

  // Past this point the page doesn't branch on which DB it is reading: both
  // hand back MonthlyRow, so every chart, projection and stat below is
  // untouched by the unit filter.
  const loadState = isAll ? grouping.loadState : units.loadState;
  const error = isAll ? grouping.error : units.error;

  const queryMonthly = useCallback(
    () => (isAll ? grouping.queryMonthly() : units.queryMonthly(unit)),
    [isAll, grouping, units, unit],
  );
  const dataWindow = useMemo(
    () => (isAll ? grouping.queryDataWindow() : units.queryDataWindow(unit)),
    [isAll, grouping, units, unit],
  );

  const { allRows, rows, hasData, yr } = useMonthlyMetricGrid({
    loadState, queryMonthly, refreshKey,
  });

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
    <PageScaffold
      title={selected ? `UA SBS Monthly — ${sbsUnitLabel(selected)}` : "UA SBS Monthly Statistics"}
      description={selected ? (
        <>
          {selected.title_uk ? `${selected.title_uk} · ` : ""}One sub-unit of the SBS grouping ·
          Monthly aggregates - current month shows end-of-month projection. · The named
          units do not sum to the grouping total (~0.4% is unattributed), so read this
          against the grouping rather than as a share of it. · From{" "}
          <a href="noreferer nofollow">https://sbs-group.army/</a>
        </>
      ) : (
        <>Syly bezpilotnykh system / Unmannend System Force (SBS/USF) · Monthly aggregates - current month shows end-of-month projection. · From <a href="noreferer nofollow">https://sbs-group.army/</a></>
      )}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="sbs" />}
      headerExtra={
        <div style={{ display: "flex", gap: 20, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
          <span style={{ color: chartColors(t).damaged }}>Hit</span>
          <span style={{ color: chartColors(t).destroyed }}>Destroyed</span>
          <span style={{ color: t.textMuted }}>Lighter segment = current-month projection</span>
        </div>
      }
      // The unit picker shows even when the month range doesn't: a unit with
      // only a handful of months hides the range picker (see
      // useMonthlyMonthRange), and hiding the control that got you there would
      // strand you on that unit.
      controls={
        <>
          <UnitSelect units={unitList} value={unit} onChange={setUnit} />
          {!yr.hidden && (
            <>
              <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
              {/* No window picker → no scope toggle either; see StatScopeToggle. */}
              <StatScopeToggle />
            </>
          )}
        </>
      }
      loadState={loadState}
      error={error}
      hasData={hasData}
      gridChildren={<>
          {baseMetrics.map((m: Metric) => (
            <MonthlyBarChart
              key={m.id}
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
            subsetLabel={SUBSET_LABEL.killed}
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
            subsetLabel={SUBSET_LABEL.destroyed}
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
              subsetLabel={SUBSET_LABEL.destroyed}
              globalMax={allStats[`hit_${targetId}`]?.max ?? 0}
              globalMedian={allStats[`hit_${targetId}`]?.median ?? 0}
              globalTotal={allStats[`hit_${targetId}`]?.total ?? 0}
              globalMax2={allStats[`destroyed_${targetId}`]?.max ?? 0}
              globalMedian2={allStats[`destroyed_${targetId}`]?.median ?? 0}
              globalTotal2={allStats[`destroyed_${targetId}`]?.total ?? 0}
            />
          ))}
      </>}
    />
  );
}
