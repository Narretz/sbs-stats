import { useEffect, useState } from "react";
import { useRuAirAttacksDatabaseContext } from "@/context/useRuAirAttacksDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import {
  ATTACK_CATEGORY_KEYS,
  ATTACK_CATEGORY_LABELS,
  type AttackCategoryKey,
  type RuAirAttacksMonthlyRow,
  type MonthlyDataPoint,
} from "@/types";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

export function RuAirAttacksMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryMonthly } = useRuAirAttacksDatabaseContext();
  const [rows, setRows] = useState<RuAirAttacksMonthlyRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryMonthly());
      setHasData(true);
    }
  }, [loadState, queryMonthly, refreshKey]);

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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Monthly Russian Missile &amp; UAV Attacks
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Monthly launched totals by weapon category, per Ukrainian Air Force reports. Current month shows an end-of-month projection · source: piterfm / Kaggle <a href="https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine" rel="nofollow external">"Massive Missile Attacks on Ukraine"</a> · Updated approximately once per week
          </p>
        </div>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU air-attacks database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {ATTACK_CATEGORY_KEYS.map((k) => (
            <MonthlyBarChart
              key={k}
              title={`${ATTACK_CATEGORY_LABELS[k]} · Launched`}
              data={makeDataset(k)}
              wfull={k === "all"}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
