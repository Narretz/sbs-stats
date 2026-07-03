import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import type { ModelBreakdownEntry } from "@/types";

// Shared tooltip building blocks for every chart-tooltip in the app.
//
// Columns are opt-in per row. A caller populates whichever fields make sense
// for its data; columns with no populated cells auto-drop so single-metric
// tooltips don't render empty cells and paired tooltips stay compact.
//
// Numeric semantics, disambiguated so callers don't have to name-check each
// column header individually:
//   value    — the row's primary quantity (always shown, right-aligned).
//   share    — part-of-total percentage. Independent axis from subset. Column
//              header defaults to "%"; caller can override via `shareLabel`.
//   subset   — an absolute secondary count paired with `value` (destroyed of
//              hit, intercepted of launched, killed of casualties). Column
//              header comes from `subsetLabel`; the same label with " %"
//              appended derives the adjacent rate column (subset/value*100).
//              A single `subsetLabel` prop yields two columns because the
//              count and the rate are two views of the same concept.
//   trend    — linear-regression trend over the row's series (day-to-day
//              charts).
//   projected — end-of-period projection (current tile on projection charts).

/** One row in a tooltip table. */
export interface TooltipTableRow {
  label: string;
  color: string;
  /** Either a number (rendered with `toLocaleString`) or a pre-formatted
   *  string (used for values like "×2.3" that don't fit the numeric renderer). */
  value: number | string | null;
  /** 0..100. Part-of-total percentage. Rendered under the Share column. */
  share?: number | null;
  /** Absolute count of a secondary series that lives on the same row as
   *  `value` (destroyed vs hit, intercepted vs launched, killed vs
   *  casualties). Renders in the "<subsetLabel>" column; the rate
   *  subset/value*100 renders in the adjacent "<subsetLabel> %" column. */
  subset?: number | null;
  /** Linear-regression trend for this row's series, if any. */
  trend?: number | null;
  /** End-of-period projection (e.g., projected month-end value on the
   *  current month's bar). Only populated on the tile-in-progress, so the
   *  column auto-drops on all other tooltips. */
  projected?: number | null;
  /** Bold this row — typically the "Total" row above component rows. */
  emphasis?: "bold" | "normal";
  /** Draw a thin separator above this row (e.g., between Total and its
   *  components on stacked charts). */
  separatorAbove?: boolean;
  /** Reduce opacity to indicate this row is out-of-focus (used on the
   *  missile stacked chart where hovering one segment dims the others). */
  dimmed?: boolean;
}

interface TableProps {
  rows: TooltipTableRow[];
  /** Format numeric values other than the special-case string. Default:
   *  `n.toLocaleString()`. Callers with custom units (e.g. rounded numbers)
   *  can override. */
  formatValue?: (n: number) => string;
  /** Format the trend column. Default matches `formatValue`. */
  formatTrend?: (n: number) => string;
  /** Header for the Share column. Default `%`. Only rendered when at least
   *  one row populates `share`. */
  shareLabel?: string;
  /** Header for the Subset absolute column; when set, an adjacent
   *  "<label> %" column shows the subset/value rate. Follows chart
   *  vocabulary — `Dest` on SBS pairs, `Int` on RU air-attacks, `Killed`
   *  on Personnel. Neither column renders when this is undefined. */
  subsetLabel?: string;
}

const VALUE_MIN = 52;
const PCT_MIN = 44;
const SUBSET_MIN = 44;
const TREND_MIN = 44;
const PROJ_MIN = 44;

function fmtNum(v: number | string | null | undefined, formatValue: (n: number) => string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatValue(v);
  return "—";
}

function fmtPct(v: number | null | undefined): string {
  return typeof v === "number" ? `${v.toFixed(1)}%` : "";
}

function subsetRate(r: TooltipTableRow): number | null {
  if (r.subset == null || typeof r.value !== "number" || r.value <= 0) return null;
  return (r.subset / r.value) * 100;
}

export function TooltipTable({
  rows,
  formatValue = (n) => n.toLocaleString(),
  formatTrend,
  shareLabel = "Share %",
  subsetLabel,
}: TableProps) {
  const { theme: t } = useTheme();
  const trendFmt = formatTrend ?? formatValue;
  // Dynamically drop columns nothing populates. Subset count and subset
  // rate track separately so a row with subset=0 still shows a rate cell,
  // and a row with value=0 doesn't force a nonsense rate column.
  const hasShare = rows.some((r) => r.share != null);
  const hasSubset = subsetLabel !== undefined && rows.some((r) => r.subset != null);
  const hasSubsetRate = subsetLabel !== undefined && rows.some((r) => subsetRate(r) != null);
  const hasTrend = rows.some((r) => r.trend != null);
  const hasProjected = rows.some((r) => r.projected != null);

  const numericCell = (min: number): React.CSSProperties => ({
    minWidth: min,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  });

  return (
    <div>
      {(hasShare || hasSubset || hasSubsetRate || hasTrend || hasProjected) && (
        <div style={{
          display: "flex", gap: 12, color: t.textMuted, fontSize: 10,
          marginBottom: 3, paddingBottom: 3, borderBottom: `1px solid ${t.border}`,
        }}>
          <span style={{ flex: 1 }} />
          <span style={numericCell(VALUE_MIN)}>Value</span>
          {hasShare && <span style={numericCell(PCT_MIN)}>{shareLabel}</span>}
          {hasSubset && <span style={numericCell(SUBSET_MIN)}>{subsetLabel}</span>}
          {hasSubsetRate && <span style={numericCell(PCT_MIN)}>{subsetLabel} %</span>}
          {hasProjected && <span style={numericCell(PROJ_MIN)}>Projected</span>}
          {hasTrend && <span style={numericCell(TREND_MIN)}>Trend</span>}
        </div>
      )}
      {rows.map((r, i) => {
        const rate = hasSubsetRate ? subsetRate(r) : null;
        return (
          <div key={i}>
            {r.separatorAbove && (
              <div style={{ borderTop: `1px solid ${t.border}`, margin: "3px 0" }} />
            )}
            <div style={{
              display: "flex", gap: 12, color: r.color,
              fontWeight: r.emphasis === "bold" ? 700 : 400,
              opacity: r.dimmed ? 0.5 : 1,
              padding: "1px 0",
            }}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {r.label}
              </span>
              <span style={{ ...numericCell(VALUE_MIN), color: t.text, fontWeight: 700 }}>
                {fmtNum(r.value, formatValue)}
              </span>
              {hasShare && (
                <span style={{ ...numericCell(PCT_MIN), color: t.textMuted }}>
                  {fmtPct(r.share)}
                </span>
              )}
              {hasSubset && (
                <span style={{ ...numericCell(SUBSET_MIN), color: t.textMuted }}>
                  {r.subset != null ? formatValue(r.subset) : ""}
                </span>
              )}
              {hasSubsetRate && (
                <span style={{ ...numericCell(PCT_MIN), color: t.textMuted }}>
                  {fmtPct(rate)}
                </span>
              )}
              {hasProjected && (
                <span style={{ ...numericCell(PROJ_MIN), color: t.textMuted }}>
                  {r.projected != null ? formatValue(r.projected) : ""}
                </span>
              )}
              {hasTrend && (
                <span style={{ ...numericCell(TREND_MIN), color: t.muted }}>
                  {r.trend != null ? trendFmt(r.trend) : ""}
                </span>
              )}
            </div>
          </div>
        );
      })}
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

// Turn a per-model launched/intercepted breakdown into continuation rows
// appended to a chart tooltip's main TooltipTable. The interception rate
// is derived by TooltipTable from `subset/value`, so we only populate the
// absolute count here. Pass `totalForShare` (e.g. the aggregate launched
// count for the same period) to also surface each model's part-of-total
// share alongside the launched count.
// eslint-disable-next-line react-refresh/only-export-components
export function breakdownToRows(
  entries: ModelBreakdownEntry[],
  color: string,
  opts?: { totalForShare?: number },
): TooltipTableRow[] {
  const total = opts?.totalForShare;
  const hasShare = total != null && total > 0;
  return entries.map((e, i) => ({
    label: e.model,
    color,
    value: e.launched,
    subset: e.intercepted,
    share: hasShare ? (e.launched / total) * 100 : undefined,
    separatorAbove: i === 0,
  }));
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
