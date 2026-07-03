import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

// Shared tooltip building blocks for every chart-tooltip in the app.
//
// The tabular layout was retrofitted 2026-07 after paired-subset tooltips
// (SBS hit/destroyed, GSUA combat-engagements with an "Unattributed" band,
// Mediazona composition views, SBU Alfa targets) grew enough columns that
// hand-rolled `label · value` rows started jumping around when you hovered
// between adjacent cards.
//
// A single-metric tooltip and a 3-row paired tooltip go through the same
// component; TooltipTable drops the % column when no row supplies a value
// for it, and drops the Trend column likewise, so single-metric callers
// don't render awkward empty cells. Numeric columns are right-aligned with
// a `min-width` so the alignment holds across hover moves.

/** One row in a tooltip table. */
export interface TooltipTableRow {
  label: string;
  color: string;
  /** Either a number (rendered with `toLocaleString`) or a pre-formatted
   *  string (used for values like "×2.3" or "142 named" that don't fit
   *  the numeric renderer). */
  value: number | string | null;
  /** 0..100. Rendered as "42%" and drives the fair-share column. Leave
   *  undefined on rows that shouldn't contribute a %. */
  pct?: number | null;
  /** Linear-regression trend for this row's series, if any. */
  trend?: number | null;
  /** Bold this row — typically the "Total" row above component rows. */
  emphasis?: "bold" | "normal";
  /** Draw a thin separator above this row (e.g., between Total and its
   *  components on stacked charts). */
  separatorAbove?: boolean;
}

interface TableProps {
  rows: TooltipTableRow[];
  /** Format numeric values other than the special-case string. Default:
   *  `n.toLocaleString()`. Callers with custom units (e.g. rounded numbers)
   *  can override. */
  formatValue?: (n: number) => string;
  /** Format the trend column. Default matches `formatValue`. */
  formatTrend?: (n: number) => string;
}

const VALUE_MIN = 64;
const PCT_MIN = 52;
const TREND_MIN = 64;

function fmtNum(v: number | string | null | undefined, formatValue: (n: number) => string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatValue(v);
  return "—";
}

function fmtPct(v: number | null | undefined): string {
  return typeof v === "number" ? `${v.toFixed(1)}%` : "";
}

export function TooltipTable({
  rows,
  formatValue = (n) => n.toLocaleString(),
  formatTrend,
}: TableProps) {
  const { theme: t } = useTheme();
  const trendFmt = formatTrend ?? formatValue;
  // Dynamically drop columns nothing populates — a single-metric caller
  // just gets Value + Trend, a composition tooltip gets Value + %, etc.
  const hasPct = rows.some((r) => r.pct != null);
  const hasTrend = rows.some((r) => r.trend != null);

  const numericCell = (min: number): React.CSSProperties => ({
    minWidth: min,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  });

  return (
    <div>
      {(hasPct || hasTrend) && (
        <div style={{
          display: "flex", gap: 12, color: t.textMuted, fontSize: 10,
          marginBottom: 3, paddingBottom: 3, borderBottom: `1px solid ${t.border}`,
        }}>
          <span style={{ flex: 1 }} />
          <span style={numericCell(VALUE_MIN)}>Value</span>
          {hasPct && <span style={numericCell(PCT_MIN)}>%</span>}
          {hasTrend && <span style={numericCell(TREND_MIN)}>Trend</span>}
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i}>
          {r.separatorAbove && (
            <div style={{ borderTop: `1px solid ${t.border}`, margin: "3px 0" }} />
          )}
          <div style={{
            display: "flex", gap: 12, color: r.color,
            fontWeight: r.emphasis === "bold" ? 700 : 400,
            padding: "1px 0",
          }}>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {r.label}
            </span>
            <span style={{ ...numericCell(VALUE_MIN), color: t.text, fontWeight: r.emphasis === "bold" ? 700 : 700 }}>
              {fmtNum(r.value, formatValue)}
            </span>
            {hasPct && (
              <span style={{ ...numericCell(PCT_MIN), color: t.textMuted }}>
                {fmtPct(r.pct)}
              </span>
            )}
            {hasTrend && (
              <span style={{ ...numericCell(TREND_MIN), color: t.muted }}>
                {r.trend != null ? trendFmt(r.trend) : ""}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// Shared wrapper: the card box (border, padding, shadow, mono font),
// an optional header line above the table (usually the formatted date),
// and an optional footer slot for note badges, EoD estimates, or a
// nested ModelBreakdownTable. Every tooltip in the app uses this shell.
interface CardProps {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  minWidth?: number;
}

export function TooltipCard({ header, footer, children, minWidth = 220 }: CardProps) {
  const { theme: t } = useTheme();
  return (
    <div style={{
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: "8px 10px",
      fontFamily: FONTS.mono,
      fontSize: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      minWidth,
    }}>
      {header != null && (
        <div style={{ color: t.textMuted, marginBottom: 4 }}>{header}</div>
      )}
      {children}
      {footer}
    </div>
  );
}
