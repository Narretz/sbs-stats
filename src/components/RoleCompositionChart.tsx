import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from "recharts";
import { useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import {
  MEDIAZONA_ROLE_GROUP_KEYS, MEDIAZONA_ROLE_GROUPS,
  type MediazonaRolesRow, type MediazonaRoleGroupKey,
} from "@/types";
import type { TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";
import { usePinnedChart } from "@/components/usePinnedChart";

// No forecast region here (forecast belongs to the estimate, not the named list).
// Recent weeks ARE still sparse — names not yet identified — but that's already
// visible in the total line collapsing, and called out in the caption, so we
// don't shade a provisional window on this chart.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fmtDate(v: string): string {
  const [y, m] = v.split("-");
  return `${m}/${y.slice(2)}`;
}
function fmtFullDate(v: string): string {
  const [y, m, d] = v.split("-");
  return `${d}.${m}.${y}`;
}
function fmtMonthYear(v: string): string {
  const [y, m] = v.split("-");
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

function describeComposition(
  row: MediazonaRolesRow,
  bucket: "weekly" | "monthly",
): TooltipDescriptor {
  const total = row.total || 1;
  const header = bucket === "monthly"
    ? `Month of ${fmtMonthYear(row.week)} · ${row.total.toLocaleString()} named`
    : `Week of ${fmtFullDate(row.week)} · ${row.total.toLocaleString()} named`;
  const rows: TooltipTableRow[] = [...MEDIAZONA_ROLE_GROUP_KEYS].reverse().map((k) => {
    const v = row[k] ?? 0;
    const g = MEDIAZONA_ROLE_GROUPS[k];
    return { label: g.label, color: g.color, value: v, share: (v / total) * 100 };
  });
  return { header, rows, minWidth: 240 };
}

export function RoleCompositionChart({
  rows,
  bucket = "weekly",
}: {
  rows: MediazonaRolesRow[];
  bucket?: "weekly" | "monthly";
}) {
  const { theme: t } = useTheme();

  const totalSum = useMemo(() => rows.reduce((s, r) => s + (r.total ?? 0), 0), [rows]);
  const totalLabel = bucket === "monthly" ? "Monthly total" : "Weekly total";

  const pin = usePinnedChart({
    chartId: "mediazona-role-composition",
    title: "Composition of confirmed deaths — share by force type",
    data: rows,
    xOf: (r) => r.week,
    describe: (r) => describeComposition(r, bucket),
    formatLabel: (r) => bucket === "monthly" ? fmtMonthYear(r.week) : fmtFullDate(r.week),
    cursor: { stroke: t.textMuted, strokeWidth: 1 },
    // Two Y axes on this chart, so the pinned line has to name one.
    cursorProps: { yAxisId: "left" },
  });

  return (
    <div className="daily-card" {...pin.cardProps} style={{
      background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
      padding: "18px 16px 12px", gridColumn: "1 / -1",
      animation: "fadeIn 0.3s ease both", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      cursor: "pointer",
    }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 12, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
        Composition of confirmed deaths — share by force type
      </div>
      <div style={{ display: "flex", gap: 14, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: t.text }}>━ {totalLabel} <span style={{ opacity: 0.7 }}>· {totalSum.toLocaleString()} cum.</span></span>
        {MEDIAZONA_ROLE_GROUP_KEYS.map((k) => (
          <span key={k} style={{ color: MEDIAZONA_ROLE_GROUPS[k].color }}>● {MEDIAZONA_ROLE_GROUPS[k].label}</span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={rows} stackOffset="expand" margin={{ top: 8, right: 12, left: -6, bottom: 0 }} {...pin.chartProps}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.chartGrid} />
          <XAxis dataKey="week"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false} minTickGap={28} tickFormatter={fmtDate}
          />
          {/* Left axis = stack shares (0..100%); right axis = absolute weekly total. */}
          <YAxis yAxisId="left" tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
            domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
          <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }} tickLine={false} axisLine={false}
            tickFormatter={(v: number) => v.toLocaleString()} />
          {pin.tooltip}
          {MEDIAZONA_ROLE_GROUP_KEYS.map((k: MediazonaRoleGroupKey) => (
            <Area key={k} yAxisId="left" type="monotone" dataKey={k} name={MEDIAZONA_ROLE_GROUPS[k].label}
              stackId="1" stroke={MEDIAZONA_ROLE_GROUPS[k].color} fill={MEDIAZONA_ROLE_GROUPS[k].color}
              fillOpacity={0.8} strokeWidth={0.5} isAnimationActive={false} />
          ))}
          {/* Absolute weekly total on the right axis — restores the scale info lost
              by 0–100% normalisation and visually shows the tail collapsing. */}
          <Line yAxisId="right" type="monotone" dataKey="total" stroke={t.text} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          {/* Painted last so it reads as a crosshair over the series,
              not a stub buried under a bar. */}
          {pin.cursor}
        </ComposedChart>
      </ResponsiveContainer>
      {pin.sheet}
    </div>
  );
}
