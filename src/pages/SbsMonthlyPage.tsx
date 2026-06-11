import { useMemo, useEffect, useState } from "react";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyYearRange } from "@/hooks/useMonthlyYearRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { MonthlyTargetPairChart, type MonthlyTargetPairDataPoint } from "@/components/MonthlyTargetPairChart";
import { YearRangeSelect } from "@/components/YearRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { buildMetrics } from "@/utils/metrics";
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

  const makeDataset = (key: StatKey): MonthlyDataPoint[] =>
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
    });

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
        {!yr.hidden && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <YearRangeSelect options={yr.yearOptions} value={yr.years} onChange={yr.setYears} />
          </div>
        )}
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
          />
          <MonthlyTargetPairChart
            key="targets-hit-destroyed"
            title="Targets Hit / Destroyed"
            data={makeTargetsPairDataset()}
          />
          {TARGET_IDS.map((targetId) => (
            <MonthlyTargetPairChart
              key={`target-pair-${targetId}`}
              title={TARGET_LABELS[targetId]}
              data={makeTargetPairDataset(targetId)}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
