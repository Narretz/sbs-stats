import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { chartColors } from "@/chartColors";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { chartAnchor } from "@/utils/chartAnchor";
import { CIT_REGION_LABELS, type CitRegionRow } from "@/types";

// A ranked magnitude comparison across ~30 named places, where the identity of
// each row matters as much as its size. That is a table's job, not a chart's —
// a 30-category bar chart is unreadable and a pie is worse. The inline bar
// gives the magnitude at a glance without pretending to be a plot; killed and
// injured are scaled independently because they differ by roughly an order of
// magnitude and one shared scale would flatten the killed column to nothing.

interface Props {
  rows: CitRegionRow[];
  // Rows beyond this are folded into an "Other regions" line rather than
  // cycling more categories — the tail is long and individually tiny.
  limit?: number;
}

function label(row: CitRegionRow): string {
  const base = CIT_REGION_LABELS[row.region_key]
    ?? row.region_key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return row.occupied ? `${base} (occupied)` : base;
}

export function CitRegionTable({ rows, limit = 18 }: Props) {
  const { theme: t } = useTheme();
  const colors = chartColors(t);

  const sorted = [...rows].sort((a, b) => (b.killed + b.injured) - (a.killed + a.injured));
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const other = tail.reduce(
    (acc, r) => ({ killed: acc.killed + r.killed, injured: acc.injured + r.injured }),
    { killed: 0, injured: 0 },
  );
  const maxKilled = Math.max(1, ...sorted.map((r) => r.killed));
  const maxInjured = Math.max(1, ...sorted.map((r) => r.injured));

  const cell: React.CSSProperties = {
    fontFamily: FONTS.mono, fontSize: 11, color: t.text,
    padding: "4px 8px", whiteSpace: "nowrap",
  };
  const headCell: React.CSSProperties = {
    ...cell, color: t.textMuted, textAlign: "right", fontWeight: 400,
    borderBottom: `1px solid ${t.border}`,
  };

  const bar = (value: number, max: number, color: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
      <span style={{ minWidth: 44, textAlign: "right" }}>{value.toLocaleString()}</span>
      <div aria-hidden style={{ width: 70, height: 6, background: t.bgAlt, borderRadius: 2 }}>
        <div style={{ width: `${Math.max(2, (value / max) * 100)}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
    </div>
  );

  const row = (key: string, name: string, country: string | null, killed: number, injured: number, muted = false) => (
    <tr key={key}>
      <td style={{ ...cell, color: muted ? t.textMuted : t.text }}>{name}</td>
      <td style={{ ...cell, color: t.textMuted, textAlign: "center" }}>{country ?? "—"}</td>
      <td style={{ ...cell, textAlign: "right" }}>{bar(killed, maxKilled, colors.civiliansKilled)}</td>
      <td style={{ ...cell, textAlign: "right" }}>{bar(injured, maxInjured, colors.civiliansInjured)}</td>
    </tr>
  );

  return (
    <div className="chart-card wfull" id={chartAnchor("Casualties by region")}>
      <ChartCardTitle title="Casualties by region" />
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 420 }}>
          <thead>
            <tr>
              <th style={{ ...headCell, textAlign: "left" }}>Region</th>
              <th style={{ ...headCell, textAlign: "center" }}>Side</th>
              <th style={headCell}>Killed</th>
              <th style={headCell}>Injured</th>
            </tr>
          </thead>
          <tbody>
            {head.map((r) => row(`${r.region_key}-${r.occupied}`, label(r), r.country, r.killed, r.injured))}
            {tail.length > 0 &&
              row("other", `Other regions (${tail.length})`, null, other.killed, other.injured, true)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
