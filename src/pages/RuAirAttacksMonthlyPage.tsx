import { useEffect, useMemo, useState } from "react";
import { useRuAirAttacksDatabaseContext } from "@/context/useRuAirAttacksDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { useMonthlyYearRange } from "@/hooks/useMonthlyYearRange";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { MonthlyTargetPairChart, type MonthlyTargetPairDataPoint } from "@/components/MonthlyTargetPairChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { YearRangeSelect } from "@/components/YearRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import {
  ATTACK_CATEGORY_LABELS,
  ATTACK_DB_CATEGORIES,
  FEATURED_MODELS,
  type AttackCategoryKey,
  type AttackDbCategory,
  type ModelBreakdownEntry,
  type RuAirAttacksMonthlyRow,
  type RuAirAttacksModelMonthlyRow,
  type MonthlyDataPoint,
} from "@/types";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";

interface Props {
  refreshKey?: number;
}

export function RuAirAttacksMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryMonthlyByModel, queryMonthlyBreakdownByCategory, queryMonthlyAggBreakdown, queryDataWindow } = useRuAirAttacksDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [allRows, setAllRows] = useState<RuAirAttacksMonthlyRow[]>([]);
  const [allModelRows, setAllModelRows] = useState<Record<string, RuAirAttacksModelMonthlyRow[]>>({});
  const [breakdowns, setBreakdowns] = useState<Record<AttackDbCategory, Map<string, ModelBreakdownEntry[]>>>({} as Record<AttackDbCategory, Map<string, ModelBreakdownEntry[]>>);
  const [allBreakdown, setAllBreakdown] = useState<Map<string, ModelBreakdownEntry[]>>(new Map());
  const [hasData, setHasData] = useState(false);
  const yr = useMonthlyYearRange(allRows.length);

  useEffect(() => {
    if (loadState === "ready") {
      setAllRows(queryMonthly());
      const m: Record<string, RuAirAttacksModelMonthlyRow[]> = {};
      for (const model of FEATURED_MODELS) m[model] = queryMonthlyByModel(model);
      setAllModelRows(m);
      const b = {} as Record<AttackDbCategory, Map<string, ModelBreakdownEntry[]>>;
      for (const cat of ATTACK_DB_CATEGORIES) b[cat] = queryMonthlyBreakdownByCategory(cat);
      setBreakdowns(b);
      setAllBreakdown(queryMonthlyAggBreakdown());
      setHasData(true);
    }
  }, [loadState, queryMonthly, queryMonthlyByModel, queryMonthlyBreakdownByCategory, queryMonthlyAggBreakdown, refreshKey]);

  // Slice to the last N*12 months (including the current/projected month at
  // the tail). The query returns the full history sorted ascending.
  const rows = useMemo(() => yr.slice(allRows), [allRows, yr]);
  const modelRows = useMemo(() => {
    const out: Record<string, RuAirAttacksModelMonthlyRow[]> = {};
    for (const m of FEATURED_MODELS) out[m] = yr.slice(allModelRows[m] ?? []);
    return out;
  }, [allModelRows, yr]);

  // Whole-dataset (cat | model) stats for the "all" stat scope. Computed off
  // the un-sliced rows so the labels don't shrink when the user narrows the
  // year range.
  const allStats = useMemo(() => {
    const cat: Record<string, { max: number; median: number; total: number }> = {};
    const catInt: Record<string, { max: number; median: number; total: number }> = {};
    for (const k of [...ATTACK_DB_CATEGORIES, "all"] as const) {
      cat[k] = maxMedian(allRows.map((r) => (typeof r[k as AttackCategoryKey] === "number" ? (r[k as AttackCategoryKey] as number) : null)));
      catInt[k] = maxMedian(allRows.map((r) => {
        const v = r[`${k as AttackCategoryKey}_intercepted` as keyof RuAirAttacksMonthlyRow];
        return typeof v === "number" ? v : null;
      }));
    }
    const model: Record<string, { max: number; median: number; total: number }> = {};
    const modelInt: Record<string, { max: number; median: number; total: number }> = {};
    for (const m of FEATURED_MODELS) {
      model[m] = maxMedian((allModelRows[m] ?? []).map((r) => r.launched));
      modelInt[m] = maxMedian((allModelRows[m] ?? []).map((r) => r.intercepted));
    }
    return { cat, catInt, model, modelInt };
  }, [allRows, allModelRows]);

  const endMonth = resolvedEndMonth();
  const makeDataset = (key: AttackCategoryKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
      rows.map((d) => {
        const value = typeof d[key] === "number" ? (d[key] as number) : null;
        const projected = d[`${key}_projected`];
        return {
          date: d.date,
          value,
          gap: projected != null && value != null ? projected - value : undefined,
          projected,
          projection_day: d.projection_day ?? undefined,
          projection_days_in_month: d.projection_days_in_month ?? undefined,
        };
      }),
      endMonth,
    );

  // Launched vs intercepted pair, reusing the SBS hit/destroyed chart shape.
  // `hit_*` = launched (primary), `destroyed_*` = intercepted (secondary), so
  // the chart's built-in ratio = % intercepted.
  const makePairDataset = (key: AttackCategoryKey): MonthlyTargetPairDataPoint[] =>
    rows.map((d) => {
      const launched = (d[key] as number) ?? 0;
      const launchedProjected = d[`${key}_projected`];
      const intercepted = (d[`${key}_intercepted`] as number) ?? 0;
      const interceptedProjected = d[`${key}_intercepted_projected`];
      return {
        date: d.date,
        hit_value: launched,
        hit_gap: launchedProjected != null ? launchedProjected - launched : undefined,
        hit_projected: launchedProjected,
        destroyed_value: intercepted,
        destroyed_gap: interceptedProjected != null ? interceptedProjected - intercepted : undefined,
        destroyed_projected: interceptedProjected,
        projection_day: d.projection_day ?? undefined,
        projection_days_in_month: d.projection_days_in_month ?? undefined,
      };
    });

  // Same shape, one chart per featured model. Bundled "X and Y" rows aren't
  // counted here so standalone-model attribution may read low when piterfm
  // reports a mixed strike.
  const makeModelPairDataset = (model: string): MonthlyTargetPairDataPoint[] =>
    (modelRows[model] ?? []).map((d) => ({
      date: d.date,
      hit_value: d.launched,
      hit_gap: d.launched_projected != null ? d.launched_projected - d.launched : undefined,
      hit_projected: d.launched_projected,
      destroyed_value: d.intercepted,
      destroyed_gap: d.intercepted_projected != null ? d.intercepted_projected - d.intercepted : undefined,
      destroyed_projected: d.intercepted_projected,
      projection_day: d.projection_day ?? undefined,
      projection_days_in_month: d.projection_days_in_month ?? undefined,
    }));

  return (
    <div>
<div style={{ display: "flex", gap: 8, flexDirection: 'column', marginBottom: 28 }}>

          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Monthly Russian Missile &amp; UAV Attacks
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Monthly launched vs intercepted totals by weapon category, per Ukrainian Air Force reports. Current month shows an end-of-month projection · source: piterfm / Kaggle <a target="_blank" href="https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine" rel="nofollow external">"Massive Missile Attacks on Ukraine"</a> · Updated approximately once per week
          </p>
          <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-air-attacks" />
        <div style={{ display: "flex", gap: 20, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
          <span style={{ color: chartColors(t).damaged }}>Launched</span>
          <span style={{ color: chartColors(t).destroyed }}>Intercepted</span>
          <span style={{ color: t.textMuted }}>Lighter segment = current-month projection</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {!yr.hidden && (
            <YearRangeSelect options={yr.yearOptions} value={yr.years} onChange={yr.setYears} />
          )}
          <StatScopeToggle />
        </div>

      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU air-attacks database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {/* All — launched only (full width). Interception rate on the mixed
              drone+missile bucket is misleading because the launch mix shifts
              month to month. */}
          <MonthlyBarChart
            key="all"
            title={`${ATTACK_CATEGORY_LABELS.all} · Launched`}
            data={makeDataset("all")}
            breakdownByMonth={allBreakdown}
            breakdownHeader="Category"
            wfull
            globalMax={allStats.cat.all?.max ?? 0}
            globalMedian={allStats.cat.all?.median ?? 0}
            globalTotal={allStats.cat.all?.total ?? 0}
          />
          {ATTACK_DB_CATEGORIES.map((k) => (
            <MonthlyTargetPairChart
              key={k}
              title={ATTACK_CATEGORY_LABELS[k]}
              data={makePairDataset(k)}
              primaryLabel="Launched"
              secondaryLabel="Intercepted"
              showRatio
              ratioLabel="% intercepted"
              breakdownByMonth={breakdowns[k]}
              globalMax={allStats.cat[k]?.max ?? 0}
              globalMedian={allStats.cat[k]?.median ?? 0}
              globalTotal={allStats.cat[k]?.total ?? 0}
              globalMax2={allStats.catInt[k]?.max ?? 0}
              globalMedian2={allStats.catInt[k]?.median ?? 0}
              globalTotal2={allStats.catInt[k]?.total ?? 0}
            />
          ))}
          {FEATURED_MODELS.map((model) => (
            <MonthlyTargetPairChart
              key={`model-${model}`}
              title={model}
              data={makeModelPairDataset(model)}
              primaryLabel="Launched"
              secondaryLabel="Intercepted"
              showRatio
              ratioLabel="% intercepted"
              globalMax={allStats.model[model]?.max ?? 0}
              globalMedian={allStats.model[model]?.median ?? 0}
              globalTotal={allStats.model[model]?.total ?? 0}
              globalMax2={allStats.modelInt[model]?.max ?? 0}
              globalMedian2={allStats.modelInt[model]?.median ?? 0}
              globalTotal2={allStats.modelInt[model]?.total ?? 0}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
