import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS, type Theme } from "@/theme";
import { TooltipCard, TooltipTable, type TooltipTableRow } from "@/components/TooltipTable";
import type { MissileSeries } from "@/data/missiles";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtTick = (v: number) => {
  const d = new Date(v);
  return `${MONTHS[d.getUTCMonth() + 1]} '${String(d.getUTCFullYear()).slice(2)}`;
};

interface BarRow { t: number; [key: string]: number | null; }

function BarTooltip({ active, payload, label, t, unit, hovered, labelFor, colorFor }: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number | null }>;
  label?: number;
  t: Theme;
  unit: string;
  hovered: string | null;
  labelFor: Map<string, string>;
  colorFor: Map<string, string>;
}) {
  if (!active || !payload?.length || label == null) return null;
  const items = payload
    .filter((p): p is { dataKey: string; value: number } => typeof p.value === "number" && !!p.dataKey)
    .sort((a, b) => b.value - a.value);
  if (!items.length) return null;
  const total = items.reduce((s, r) => s + r.value, 0);
  // Total on top (bold), items below with share of total. Non-hovered
  // items are dimmed to preserve the segment-focus behaviour of the
  // stacked bars.
  const rows: TooltipTableRow[] = [
    { label: "itemised total*", color: t.text, value: total, emphasis: "bold" },
    ...items.map((r, i) => ({
      label: labelFor.get(r.dataKey) ?? r.dataKey,
      color: colorFor.get(r.dataKey) ?? t.textMuted,
      value: r.value,
      share: total > 0 ? (r.value / total) * 100 : null,
      emphasis: (hovered === r.dataKey ? "bold" : "normal") as "bold" | "normal",
      dimmed: hovered != null && hovered !== r.dataKey,
      separatorAbove: i === 0,
    })),
  ];
  const header = `${fmtTick(label)} · ${items.length} types · ${unit}`;
  return (
    <TooltipCard header={header} minWidth={220}>
      <TooltipTable rows={rows} />
    </TooltipCard>
  );
}

interface Props {
  series: MissileSeries[];
  unit: string;
  timeDomain: [number, number];
  ticks: number[];
  // Assigned at the page level over the full type list, so colours stay stable
  // per type as types are checked/unchecked.
  colorFor: Map<string, string>;
}

export function MissileStackedBarChart({ series, unit, timeDomain, ticks, colorFor }: Props) {
  const { theme: t } = useTheme();
  const [hovered, setHovered] = useState<string | null>(null);

  const labelFor = useMemo(() => new Map(series.map((s) => [s.key, s.label])), [series]);

  // One stacked bar per report (placed at its real timestamp); each type a
  // segment = its central estimate. A type absent from a report just isn't in
  // that stack. NB: bounds are collapsed to midpoints to stack at all.
  const rows = useMemo(() => {
    const byT = new Map<number, BarRow>();
    for (const s of series) {
      for (const p of s.points) {
        if (!byT.has(p.t)) byT.set(p.t, { t: p.t });
        byT.get(p.t)![s.key] = p.mid;
      }
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }, [series]);

  return (
    <div className="daily-card" style={{
      background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
      padding: "18px 16px 12px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <ResponsiveContainer width="100%" height={460}>
        <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          onMouseLeave={() => setHovered(null)}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} vertical={false} />
          <XAxis
            type="number" dataKey="t" scale="time" domain={timeDomain} ticks={ticks}
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false} tickFormatter={fmtTick}
          />
          <YAxis
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false} allowDecimals={false}
          />
          <Tooltip
            wrapperStyle={{ zIndex: 9999 }}
            cursor={{ fill: t.textMuted, fillOpacity: 0.06 }}
            content={(props) => (
              <BarTooltip
                active={props.active}
                payload={props.payload as Array<{ dataKey?: string; value?: number | null }> | undefined}
                label={props.label as number | undefined}
                t={t} unit={unit} hovered={hovered} labelFor={labelFor} colorFor={colorFor}
              />
            )}
          />
          <Legend wrapperStyle={{ fontFamily: FONTS.mono, fontSize: 10 }} />
          {series.map((s) => (
            <Bar
              key={s.key} dataKey={s.key} name={s.label} stackId="all"
              fill={colorFor.get(s.key)} barSize={30}
              fillOpacity={hovered && hovered !== s.key ? 0.18 : 1}
              onMouseEnter={() => setHovered(s.key)}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
