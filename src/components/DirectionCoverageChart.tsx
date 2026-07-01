import { useMemo } from "react";
import {
  BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import type { GsuaDirectionCoverageRow } from "@/types";

// Per-day stacked bar of combat engagements, broken down by direction with
// an "Other" catch-all for the long tail and an "Unattributed" stack for the
// gap between the day's `combat_engagements` and the sum of its per-direction
// attacks. All numbers come from the SAME canonical report per date (see
// queryDirectionCoverage), so the Unattributed height is the honest gap.

interface Props {
  data: GsuaDirectionCoverageRow[];
  wfull?: boolean;
  // `daily`: rows keyed by YYYY-MM-DD; `monthly`: rows keyed by YYYY-MM
  // (each row summing the month's canonical daily reports). Affects the
  // x-axis tick format, the sub-title copy, and the units in the summary
  // line ("days with a breakdown" vs "months").
  granularity?: "daily" | "monthly";
}

const MAX_BAR_SIZE = 32;
const UNATTRIBUTED_KEY = "__unattributed";
const COLOR_UNATTRIBUTED = "#9ca3af";

// 24-color qualitative palette — covers every direction present in the DB
// (26 all-time, 16 max on a single day) without collapsing any into an
// "Other" bucket. Colors are interleaved from opposite hue families so
// adjacent stacks stay visually distinct even when 10+ appear in one bar.
const DIRECTION_PALETTE = [
  "#3b82f6", "#ef4444", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899",
  "#14b8a6", "#f97316", "#06b6d4", "#a855f7", "#84cc16", "#f43f5e",
  "#0ea5e9", "#eab308", "#7c3aed", "#22c55e", "#e11d48", "#0891b2",
  "#c026d3", "#65a30d", "#b45309", "#4f46e5", "#059669", "#be123c",
];

interface Stack {
  key: string;      // dataKey used on the flattened chart rows
  label: string;    // human label
  color: string;
}

interface FlatRow {
  date: string;
  total: number | null;
  [dataKey: string]: number | string | null;
}

export function DirectionCoverageChart({ data, wfull, granularity = "daily" }: Props) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const bucketLabel = granularity === "monthly" ? "months" : "days";

  const { stacks, flat, summary } = useMemo(() => {
    // One stack per direction seen in the window — no "Other" bucket; the
    // full dataset never carries more than 16 distinct directions on a
    // single day, so the legend stays manageable.
    const totalPerDir = new Map<string, number>();
    for (const row of data) {
      for (const [dir, attacks] of Object.entries(row.byDirection)) {
        totalPerDir.set(dir, (totalPerDir.get(dir) ?? 0) + attacks);
      }
    }
    const sortedDirs = [...totalPerDir.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    // Stack order: biggest at bottom (stable base) → Unattributed on top.
    const stacks: Stack[] = sortedDirs.map((name, i) => ({
      key: name, label: name, color: DIRECTION_PALETTE[i % DIRECTION_PALETTE.length],
    }));
    stacks.push({ key: UNATTRIBUTED_KEY, label: "Unattributed", color: COLOR_UNATTRIBUTED });

    // Flatten each date into { date, total, <each stack.key>: N }.
    const flat: FlatRow[] = data.map((row) => {
      const out: FlatRow = { date: row.date, total: row.total };
      for (const [dir, attacks] of Object.entries(row.byDirection)) {
        out[dir] = attacks;
      }
      out[UNATTRIBUTED_KEY] = row.unattributed;
      return out;
    });

    // Header summary: coverage % over the window, buckets with any breakdown.
    let attributed = 0, unattributed = 0, bucketsWithBreakdown = 0;
    for (const r of data) {
      attributed += r.attributed;
      unattributed += r.unattributed;
      if (r.attributed > 0) bucketsWithBreakdown += 1;
    }
    const grandTotal = attributed + unattributed;
    const pctAttributed = grandTotal > 0 ? (attributed / grandTotal) * 100 : 0;
    const summary = {
      bucketsWithBreakdown, bucketsTotal: data.length, pctAttributed,
      directionCount: totalPerDir.size,
    };

    return { stacks, flat, summary };
  }, [data]);

  const num = (n: number | null | undefined) =>
    typeof n === "number" ? n.toLocaleString() : "n/a";

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
      <div style={{
        fontFamily: FONTS.display, fontWeight: 700, fontSize: 12,
        color: t.textMuted, letterSpacing: "0.07em",
        textTransform: "uppercase", marginBottom: 6,
      }}>
        Combat Engagements — Composition by Direction
      </div>
      <div style={{
        fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, marginBottom: 10,
      }}>
        Each {granularity === "monthly" ? "month's" : "day's"} combat engagements
        split by the direction named in the General Staff report. "Unattributed"
        is the gap between the report's total and the sum of its per-direction
        counts. In an <a href="https://youtu.be/2loliH9Hy9w?si=axY4UMLFFsObcIah&t=1133" rel="nofollow external">interview by TCH published on 2026-06-30</a>,
        commander in chief of the AFU Syrskyi said up to 45% of recorded attacks are carried out by Ukrainian
        forces, so it's likely they are "unattributed" and not further specified for opsec reasons.
      </div>
      <div style={{
        display: "flex", flexWrap: "wrap", gap: "6px 14px", marginBottom: 10,
        fontFamily: FONTS.mono, fontSize: 10,
      }}>
        {stacks.map((s) => (
          <span key={s.key} style={{ color: s.color }}>■ {s.label}</span>
        ))}
        <span style={{ color: t.textMuted, marginLeft: "auto" }}>
          {summary.bucketsWithBreakdown}/{summary.bucketsTotal} {bucketLabel} with a breakdown
          {" · "}{summary.pctAttributed.toFixed(0)}% of attacks attributed
          {" · "}{summary.directionCount} direction{summary.directionCount === 1 ? "" : "s"} seen
        </span>
      </div>
      <ResponsiveContainer width="100%" height={400}>
        <BarChart data={flat} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
            // daily rows: YYYY-MM-DD → MM-DD; monthly rows: YYYY-MM → YY/MM
            tickFormatter={(v: string) =>
              granularity === "monthly"
                ? `${v.slice(2, 4)}/${v.slice(5, 7)}`
                : v.slice(5)}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 10, fill: t.textMuted, fontFamily: FONTS.mono }}
            tickLine={false} axisLine={false}
          />
          <Tooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 9999 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as FlatRow;
              // Show stacks in reverse render order (top-of-bar first) with
              // zero-valued entries hidden.
              const rows = [...stacks].reverse().filter((s) => {
                const v = d[s.key];
                return typeof v === "number" && v > 0;
              });
              return (
                <div style={{
                  background: t.surface, border: `1px solid ${t.border}`,
                  borderRadius: 6, padding: "10px 14px",
                  fontFamily: FONTS.mono, fontSize: 12,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                }}>
                  <div style={{ color: t.textMuted, marginBottom: 6 }}>{d.date}</div>
                  {rows.map((s) => {
                    const v = d[s.key] as number;
                    const totalN = typeof d.total === "number" ? d.total : 0;
                    // Show % of the day's total next to the Unattributed row —
                    // that's the reader's "how big is the gap" reference.
                    // Skip on other stacks to keep the tooltip compact.
                    const showPct = s.key === UNATTRIBUTED_KEY && totalN > 0;
                    return (
                      <div key={s.key} style={{ color: s.color }}>
                        {s.label}: <span style={{ color: t.text, fontWeight: 700 }}>{num(v)}</span>
                        {showPct && (
                          <span style={{ color: t.textMuted, fontWeight: 400 }}>
                            {" "}({((v / totalN) * 100).toFixed(0)}%)
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <div style={{ color: t.textMuted, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${t.border}` }}>
                    Total: <span style={{ color: t.text, fontWeight: 700 }}>{num(d.total)}</span>
                  </div>
                </div>
              );
            }}
          />
          {stacks.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="a"
              name={s.label}
              fill={s.color}
              maxBarSize={MAX_BAR_SIZE}
              // Round only the topmost stack (last in render order).
              radius={i === stacks.length - 1 ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
