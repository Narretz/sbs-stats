import { useEffect, useMemo, useState } from "react";
import { useRuAirAttacksDatabaseContext } from "@/context/useRuAirAttacksDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { MonthlyTargetPairChart, type MonthlyTargetPairDataPoint } from "@/components/MonthlyTargetPairChart";
import { DataWindow } from "@/components/DataWindow";
import { YearRangeSelect } from "@/components/YearRangeSelect";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import {
  ATTACK_CATEGORY_LABELS,
  ATTACK_DB_CATEGORIES,
  type AttackCategoryKey,
  type RuAirAttacksMonthlyRow,
  type MonthlyDataPoint,
} from "@/types";
import { DEFAULT_YEAR_OPTION, getYearOptions, type YearOption } from "@/utils/yearRange";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";

interface Props {
  refreshKey?: number;
}

function parseYearsParam(raw: string | null, allowed: readonly YearOption[]): YearOption {
  const n = Number(raw);
  return (allowed as readonly number[]).includes(n) ? (n as YearOption) : DEFAULT_YEAR_OPTION;
}

function setYearsParam(years: YearOption) {
  const p = new URLSearchParams(window.location.search);
  p.set("years", String(years));
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

export function RuAirAttacksMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly, queryDataWindow } = useRuAirAttacksDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const yearOptions = useMemo(() => getYearOptions(), []);
  const [years, setYears] = useState<YearOption>(() =>
    parseYearsParam(new URLSearchParams(window.location.search).get("years"), yearOptions)
  );
  const [allRows, setAllRows] = useState<RuAirAttacksMonthlyRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setAllRows(queryMonthly());
      setHasData(true);
    }
  }, [loadState, queryMonthly, refreshKey]);

  const updateYears = (y: YearOption) => { setYears(y); setYearsParam(y); };

  // Slice to the last N*12 months (including the current/projected month at
  // the tail). The query returns the full history sorted ascending.
  const rows = useMemo(() => {
    const want = years * 12;
    return allRows.length > want ? allRows.slice(allRows.length - want) : allRows;
  }, [allRows, years]);

  const makeDataset = (key: AttackCategoryKey): MonthlyDataPoint[] =>
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
    });

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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Monthly Russian Missile &amp; UAV Attacks
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Monthly launched vs intercepted totals by weapon category, per Ukrainian Air Force reports. Current month shows an end-of-month projection · source: piterfm / Kaggle <a href="https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine" rel="nofollow external">"Massive Missile Attacks on Ukraine"</a> · Updated approximately once per week
          </p>
          <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-air-attacks" />
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <YearRangeSelect options={yearOptions} value={years} onChange={updateYears} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 20, marginBottom: 20, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: chartColors(t).damaged }}>Launched</span>
        <span style={{ color: chartColors(t).destroyed }}>Intercepted</span>
        <span style={{ color: t.textMuted }}>Lighter segment = current-month projection</span>
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
            wfull
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
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
