import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ResponsiveContainer,
} from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { ModelBreakdownTable } from "@/components/ModelBreakdownTable";
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
  ratioLabel?: string;
  // Optional per-month model breakdown (YYYY-MM → entries). When provided,
  // the tooltip renders the shared ModelBreakdownTable under the standard
  // hit/destroyed rows. Used by the RU air-attacks category charts.
  breakdownByMonth?: Map<string, ModelBreakdownEntry[]>;
}

const MonthlyPairTooltip = ({
  active, payload, t, c, primaryLabel, secondaryLabel, showRatio, ratioLabel, breakdownByMonth,
}: {
  active?: boolean;
  payload?: Array<{ payload: MonthlyTargetPairDataPoint }>;
  t: ReturnType<typeof useTheme>["theme"];
  c: ReturnType<typeof chartColors>;
  primaryLabel: string;
  secondaryLabel: string;
  showRatio: boolean;
  ratioLabel: string;
  breakdownByMonth?: Map<string, ModelBreakdownEntry[]>;
}) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const destroyedPct = d.hit_value > 0 ? (d.destroyed_value / d.hit_value) * 100 : null;
  const entries = breakdownByMonth?.get(d.date.slice(0, 7)) ?? [];
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`,
      borderRadius: 6, padding: "10px 14px",
      fontFamily: FONTS.mono, fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    }}>
      <div style={{ color: t.textMuted, marginBottom: 6 }}>{d.date}</div>
      <div style={{ color: c.damaged }}>
        {primaryLabel}: <span style={{ color: t.text, fontWeight: 700 }}>{d.hit_value?.toLocaleString()}</span>
        {d.hit_projected != null ? (
          <span style={{ color: t.textMuted }}> / {d.hit_projected.toLocaleString()} projected</span>
        ) : null}
      </div>
      <div style={{ color: c.destroyed }}>
        {secondaryLabel}: <span style={{ color: t.text, fontWeight: 700 }}>{d.destroyed_value?.toLocaleString()}</span>
        {d.destroyed_projected != null ? (
          <span style={{ color: t.textMuted }}> / {d.destroyed_projected.toLocaleString()} projected</span>
        ) : null}
      </div>
      {showRatio ? (
        <div style={{ color: t.textMuted, marginTop: 4 }}>
          {ratioLabel}: <span style={{ color: t.text, fontWeight: 700 }}>
            {destroyedPct == null ? "n/a" : `${destroyedPct.toFixed(1)}%`}
          </span>
        </div>
      ) : null}
      {d.projection_day != null && d.projection_days_in_month != null ? (
        <div style={{ color: t.textMuted, fontSize: 10, marginTop: 4 }}>
          Day {d.projection_day} of {d.projection_days_in_month}
        </div>
      ) : null}
      {entries.length > 0 && <ModelBreakdownTable entries={entries} t={t} />}
    </div>
  );
};

export function MonthlyTargetPairChart({
  title,
  data,
  wfull = false,
  primaryLabel = "Hit",
  secondaryLabel = "Destroyed",
  showRatio = true,
  ratioLabel = "% destroyed",
  breakdownByMonth,
}: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const lastIdx = data.length - 1;
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
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 14 }}>
        {title}
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
                ratioLabel={ratioLabel}
                breakdownByMonth={breakdownByMonth}
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
