import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ReferenceLine, ResponsiveContainer,
} from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { useStatScope } from "@/hooks/useStatScope";
import { maxMedian } from "@/utils/windowStats";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { TooltipCard, TooltipTable, breakdownToRows, type TooltipTableRow } from "@/components/TooltipTable";
import type { ModelBreakdownEntry } from "@/types";

export interface MonthlyTargetPairDataPoint {
  date: string;
  hit_value: number;
  hit_gap?: number;
  hit_projected?: number;
  destroyed_value: number;
  destroyed_gap?: number;
  destroyed_projected?: number;
  projection_day?: number;
  projection_days_in_month?: number;
}

interface Props {
  title: string;
  data: MonthlyTargetPairDataPoint[];
  wfull?: boolean;
  primaryLabel?: string;
  secondaryLabel?: string;
  showRatio?: boolean;
  /** Legacy inline label for the destroyed/hit ratio row ("% destroyed").
   *  The ratio is now surfaced as a `%` cell on the Destroyed row in the
   *  shared TooltipTable, so the label isn't rendered — kept in the type
   *  so existing callers that pass it don't need to change. */
  ratioLabel?: string;
  // Optional per-month model breakdown (YYYY-MM → entries). When provided,
  // the tooltip appends per-model continuation rows under the standard
  // hit/destroyed rows. Used by the RU air-attacks category charts.
  breakdownByMonth?: Map<string, ModelBreakdownEntry[]>;
  /** Header for the tooltip's % column (default `%`). Set to `% dest` /
   *  `% int` on ratio charts so the meaning of the ratio is explicit. */
  pctLabel?: string;
  /** Header for the Intercepted column (auto-drops if no row populates it —
   *  populated on breakdown rows). `Dest` on hit/destroyed, `Int` on
   *  launched/intercepted. */
  interceptedLabel?: string;
  // Whole-dataset stats for the "all" stat scope, primary (hit/launched) and
  // optional secondary (destroyed/intercepted). When omitted on either side
  // the chart falls back to the window-scoped values computed from `data`.
  globalMax?: number;
  globalMedian?: number;
  globalTotal?: number;
  globalMax2?: number;
  globalMedian2?: number;
  globalTotal2?: number;
}

const MonthlyPairTooltip = ({
  active, payload, t, c, primaryLabel, secondaryLabel, showRatio, breakdownByMonth,
  pctLabel, interceptedLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload: MonthlyTargetPairDataPoint }>;
  t: ReturnType<typeof useTheme>["theme"];
  c: ReturnType<typeof chartColors>;
  primaryLabel: string;
  secondaryLabel: string;
  showRatio: boolean;
  breakdownByMonth?: Map<string, ModelBreakdownEntry[]>;
  pctLabel?: string;
  interceptedLabel?: string;
}) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  // `pct` on the destroyed row = destroyed / hit * 100. That's the same
  // number the old inline "% destroyed" line surfaced; ratioLabel is dropped
  // because the row's context (Destroyed with a % cell) reads unambiguously.
  const destroyedPct = showRatio && d.hit_value > 0
    ? (d.destroyed_value / d.hit_value) * 100
    : null;
  const entries = breakdownByMonth?.get(d.date.slice(0, 7)) ?? [];
  // Collapse to one aggregate row when the chart uses the Intercepted
  // column (hit/destroyed or launched/intercepted semantic). Same rationale
  // as DailyLineChart: the standalone Destroyed / Intercepted row becomes
  // redundant with the Intercepted column that breakdown rows already fill.
  // Sum-mode / composition callers don't set interceptedLabel and keep the
  // two-row structure.
  const useCollapsedIntercept = interceptedLabel !== undefined;
  const rows: TooltipTableRow[] = useCollapsedIntercept
    ? [{
        label: primaryLabel, color: c.damaged,
        value: d.hit_value ?? null,
        pct: destroyedPct,
        intercepted: d.destroyed_value ?? null,
        projected: d.hit_projected ?? null,
      }]
    : [
        {
          label: primaryLabel, color: c.damaged,
          value: d.hit_value ?? null,
          projected: d.hit_projected ?? null,
        },
        {
          label: secondaryLabel, color: c.destroyed,
          value: d.destroyed_value ?? null,
          pct: destroyedPct,
          projected: d.destroyed_projected ?? null,
        },
      ];
  rows.push(...breakdownToRows(entries, t.textMuted));
  // "Day X of Y" is appended to the date so it reads as month-in-progress
  // context alongside the tile label, not as a bolted-on footer caption.
  // Rendered smaller (fontSize 10) so the primary date stays the anchor.
  const header = d.projection_day != null && d.projection_days_in_month != null ? (
    <>
      <div style={{display: 'flex', justifyContent: 'space-between'}}>
      <span>{d.date}</span>
      <span style={{ fontSize: 10, marginLeft: 6 }}>
        Day {d.projection_day} of {d.projection_days_in_month}
      </span>
    </div>
    </>
  ) : d.date;
  return (
    <TooltipCard header={header} minWidth={240}>
      <TooltipTable rows={rows} pctLabel={pctLabel} interceptedLabel={interceptedLabel} />
    </TooltipCard>
  );
};

export function MonthlyTargetPairChart({
  title,
  data,
  wfull = false,
  primaryLabel = "Hit",
  secondaryLabel = "Destroyed",
  showRatio = true,
  ratioLabel: _ratioLabel = "% destroyed",  // legacy prop, no longer rendered
  breakdownByMonth,
  globalMax, globalMedian, globalTotal,
  globalMax2, globalMedian2, globalTotal2,
  pctLabel, interceptedLabel,
}: Props) {
  const { theme: t } = useTheme();
  const { scope } = useStatScope();
  const c = chartColors(t);
  const lastIdx = data.length - 1;

  const win = scope === "window";
  const primaryWin = useMemo(() => maxMedian(data.map((d) => d.hit_value)), [data]);
  const secondaryWin = useMemo(() => maxMedian(data.map((d) => d.destroyed_value)), [data]);
  const max = win ? primaryWin.max : (globalMax ?? primaryWin.max);
  const median = win ? primaryWin.median : (globalMedian ?? primaryWin.median);
  const total = win ? primaryWin.total : (globalTotal ?? primaryWin.total);
  const max2 = win ? secondaryWin.max : (globalMax2 ?? secondaryWin.max);
  const median2 = win ? secondaryWin.median : (globalMedian2 ?? secondaryWin.median);
  const total2 = win ? secondaryWin.total : (globalTotal2 ?? secondaryWin.total);
  // Historical note: this chart originally used t.accent for "destroyed", while
  // DailyLineChart uses the static COLOR_DESTROYED. Routing both through
  // c.damaged / c.destroyed unifies them. The visible change is small in light
  // mode (#db2c18 → #dc2626) and larger in dark mode (orange → red), but the
  // pair is more readable. Revert by pointing destroyed_value at c.barCurrent.
  const hitProjectedFill = c.damagedProjected;
  const destroyedProjectedFill = c.destroyedProjected;

  return (
    <div className="chart-card" style={{
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: wfull ? "1 / -1" : undefined,
      animation: "fadeIn 0.3s ease both",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: c.damaged }}>● {primaryLabel}</span>
        <span style={{ color: t.accent }}>▲ MAX {max.toLocaleString()}</span>
        <span style={{ color: t.muted }}>~ MED {median.toLocaleString()}</span>
        <span style={{ color: t.textMuted }}>Σ TOTAL {total.toLocaleString()}</span>
        <span style={{ color: c.destroyed, marginLeft: 8 }}>● {secondaryLabel}</span>
        <span style={{ color: c.destroyed }}>▲ MAX {max2.toLocaleString()}</span>
        <span style={{ color: c.destroyed, opacity: 0.7 }}>~ MED {median2.toLocaleString()}</span>
        <span style={{ color: c.destroyed, opacity: 0.7 }}>Σ TOTAL {total2.toLocaleString()}</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: -10, bottom: 0 }}
          barGap={2}
        >
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: string) => v.slice(0, 7).replace("-", "/")}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false} />
          <ReferenceLine y={median} stroke={t.muted} strokeDasharray="4 4" strokeOpacity={0.5}
            label={{ value: "MED", position: "insideTopRight", fontSize: 9, fill: t.muted, fontFamily: FONTS.mono }} />
          <Tooltip
            content={({ active, payload }) => (
              <MonthlyPairTooltip
                active={active}
                payload={payload as unknown as Array<{ payload: MonthlyTargetPairDataPoint }>}
                t={t}
                c={c}
                primaryLabel={primaryLabel}
                secondaryLabel={secondaryLabel}
                showRatio={showRatio}
                breakdownByMonth={breakdownByMonth}
                pctLabel={pctLabel}
                interceptedLabel={interceptedLabel}
              />
            )}
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 9999 }}
          />

          <Bar dataKey="hit_value" stackId="hit" name={primaryLabel}>
            {data.map((_, i) => (
              <Cell key={`hit-val-${i}`} fill={i === lastIdx ? c.barCurrent : c.damaged} />
            ))}
          </Bar>
          <Bar dataKey="hit_gap" stackId="hit" name={`${primaryLabel} Projected`} radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={`hit-gap-${i}`} fill={i === lastIdx ? hitProjectedFill : "transparent"} />
            ))}
          </Bar>

          <Bar dataKey="destroyed_value" stackId="destroyed" name={secondaryLabel}>
            {data.map((_, i) => (
              <Cell key={`des-val-${i}`} fill={i === lastIdx ? c.destroyedCurrent : c.destroyed} />
            ))}
          </Bar>
          <Bar dataKey="destroyed_gap" stackId="destroyed" name={`${secondaryLabel} Projected`} radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={`des-gap-${i}`} fill={i === lastIdx ? destroyedProjectedFill : "transparent"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
