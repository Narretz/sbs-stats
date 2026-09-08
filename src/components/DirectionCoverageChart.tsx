import { useMemo } from "react";
import {
  BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { chartAnchor } from "@/utils/chartAnchor";

// This card's title is fixed, not a prop — kept here so the heading and its
// deep-link anchor are derived from one string.
const TITLE = "Combat Engagements — Composition by Direction";
import { chartColors } from "@/chartColors";
import { TooltipCard, TooltipTable, type TooltipTableRow } from "@/components/TooltipTable";
import { DIRECTION_AXIS_JOINT_LABEL } from "@/types";
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
  const anchor = chartAnchor(TITLE);
  const c = chartColors(t);
  const bucketLabel = granularity === "monthly" ? "months" : "days";

  const { stacks, flat, summary, mergedByBucket, interimByBucket } = useMemo(() => {
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
    // Per-bucket naming for the tooltip: each bar knows whether ITS reports
    // were joint, so hovering 2025-05-20 says "Kursk" and 2026-01-20 says
    // "Kursk / Pn. Slobozhanshchyna". Only the legend below has to settle on
    // one name for the whole window.
    //
    // A monthly bucket counts as joint if any report in it was — the
    // changeover month (06/2025) therefore reads as joint, which matches what
    // the bar contains: some of its attacks come from the joint line.
    const mergedByBucket = new Map<string, Set<string>>(
      data.map((row) => [row.date, new Set(row.mergedAxes ?? [])]),
    );

    // The report each bucket was built from. A snapshot dated the same day as
    // the bucket means the wrap-up report — the GS posts it the next morning —
    // hasn't landed, so the bar is an interim reading and will grow. Monthly
    // buckets aggregate many reports and carry no snapshot, so they never
    // show the marker.
    const interimByBucket = new Map<string, string>();
    for (const row of data) {
      const snap = row.snapshot_at;
      if (snap && snap.slice(0, 10) === row.date) {
        interimByBucket.set(row.date, snap.slice(11, 16));
      }
    }

    // An axis whose composition changed is named for the window on screen.
    // Showing only pre-merge buckets, it is the sector under its old name;
    // only post-merge, the joint name; spanning the changeover, the joint name
    // plus the month it happened, taken from the earliest merged bucket rather
    // than a constant so it can't drift from the reports.
    const axisLabel = (name: string): string => {
      const joint = DIRECTION_AXIS_JOINT_LABEL[name];
      if (!joint) return name;
      const mergedDates = data
        .filter((row) => row.mergedAxes?.includes(name))
        .map((row) => row.date)
        .sort();
      if (mergedDates.length === 0) return name;
      const present = data.filter((row) => row.byDirection[name] != null).length;
      if (mergedDates.length >= present) return joint;
      const [y, m] = mergedDates[0].slice(0, 7).split("-");
      return `${joint} (from ${m}/${y})`;
    };

    const stacks: Stack[] = sortedDirs.map((name, i) => ({
      key: name,
      label: axisLabel(name),
      color: DIRECTION_PALETTE[i % DIRECTION_PALETTE.length],
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

    return { stacks, flat, summary, mergedByBucket, interimByBucket };
  }, [data]);


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
      <ChartCardTitle title={TITLE} anchor={anchor} marginBottom={6} />
      <div style={{
        fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, marginBottom: 10,
      }}>
        Each {granularity === "monthly" ? "month's" : "day's"} combat engagements
        split by the direction named in the General Staff report. "Unattributed"
        is the gap between the report's total and the sum of its per-direction
        counts. Directions with decimal places are from reports that summarize multiple directions.
        In an <a href="https://youtu.be/2loliH9Hy9w?si=axY4UMLFFsObcIah&t=1133" rel="nofollow external">interview by TCH published on 2026-06-30</a>,
        commander in chief of the AFU Syrskyi said up to 45% of recorded attacks are carried out by Ukraine, so it's likely they are "unattributed" and not further specified for opsec reasons.
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
              const totalN = typeof d.total === "number" ? d.total : 0;
              // Total (bold) on top, then the breakdown sorted by this bar's own
              // value (highest first), zero-valued entries hidden. Every row
              // surfaces a share-of-total, so each direction's contribution
              // (and the Unattributed gap) is readable at a glance.
              const rows: TooltipTableRow[] = [
                { label: "Total", color: t.text, value: d.total, emphasis: "bold" },
                ...stacks
                  .filter((s) => {
                    const v = d[s.key];
                    return typeof v === "number" && v > 0;
                  })
                  .sort((a, b) => (d[b.key] as number) - (d[a.key] as number))
                  .map((s, i) => {
                    const v = d[s.key] as number;
                    const joint = DIRECTION_AXIS_JOINT_LABEL[s.key];
                    return {
                      // This bucket's own name, not the window's.
                      label: joint && mergedByBucket.get(d.date)?.has(s.key)
                        ? joint
                        : (joint ? s.key : s.label),
                      color: s.color,
                      value: v,
                      share: totalN > 0 ? (v / totalN) * 100 : null,
                      separatorAbove: i === 0,
                    };
                  }),
              ];
              // Directions actually named in this bucket. Counted off the
              // stacks rather than the rendered rows so it keys on the stack's
              // identity, not on its label or colour.
              const directionCount = stacks.filter((s) => {
                if (s.key === UNATTRIBUTED_KEY) return false;
                const v = d[s.key];
                return typeof v === "number" && v > 0;
              }).length;
              const interim = interimByBucket.get(d.date);
              return (
                <TooltipCard
                  header={
                    <>
                      {d.date}
                      {interim && (
                        // `accent` is the theme's today/in-progress highlight,
                        // which is exactly what an interim reading is.
                        <span style={{ color: t.accent }}>
                          {" · "}interim {interim} report
                        </span>
                      )}
                      {" · "}{directionCount} direction{directionCount === 1 ? "" : "s"}
                    </>
                  }
                  minWidth={240}
                >
                  <TooltipTable rows={rows} />
                </TooltipCard>
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
