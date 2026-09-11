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
  /** Number → rendered with `toLocaleString` (via `formatValue`). Anything
   *  else (string, JSX fragment) is passed through — used for values like
   *  "×2.3" that don't fit the numeric renderer, or an EoD estimate whose
   *  parenthetical fraction is styled smaller. */
  value: number | ReactNode | null;
  /** 0..100. Part-of-total percentage. Rendered under the Share column. */
  share?: number | null;
  /** Absolute count of a secondary series that lives on the same row as
   *  `value` (destroyed vs hit, intercepted vs launched, killed vs
   *  casualties). Number → the rate subset/value*100 renders in the
   *  adjacent "<subsetLabel> %" column. Anything else (string, JSX
   *  fragment) renders as-is and skips the rate cell. */
  subset?: number | ReactNode | null;
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

// Column minimums are `em`, not px, so the whole table scales from a single
// knob — the font-size of whatever wraps it. The floating hover card sets
// 12px (below), which reproduces the original 56/44px widths exactly; the
// bottom sheet drops to 10px on narrow viewports (see `.chart-sheet-body` in
// theme.css) and the columns follow without a second set of constants.
const VALUE_MIN = "4.667em";   // 56px @ 12
const PCT_MIN = "3.667em";     // 44px @ 12
const SUBSET_MIN = "4.667em";
const TREND_MIN = "3.667em";
const PROJ_MIN = "3.667em";

// Inter-column gap. A CSS variable rather than a constant so the narrow-sheet
// media query can tighten it without this module knowing about breakpoints.
const GAP = "var(--tt-gap, 12px)";

function renderCell(v: number | ReactNode | null | undefined, formatValue: (n: number) => string, empty: string): ReactNode {
  if (v == null) return empty;
  if (typeof v === "number") return formatValue(v);
  return v;
}

function fmtPct(v: number | null | undefined): string {
  return typeof v === "number" ? `${v.toFixed(1)}%` : "";
}

function subsetRate(r: TooltipTableRow): number | null {
  if (typeof r.subset !== "number" || typeof r.value !== "number" || r.value <= 0) return null;
  return (r.subset / r.value) * 100;
}

// A column header. The smaller type goes on an inner span rather than the cell
// itself: the column minimums are `em`, so a cell that shrank its own
// font-size would shrink its minimum by the same factor.
function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", paddingBottom: 3 }}>
      <span style={{ fontSize: "0.833em" }}>{children}</span>
    </span>
  );
}

// The dashed fill for "no data" on the value cell. Subset cell uses an
// empty string so an absent subset doesn't push a dash into the layout.
const VALUE_EMPTY = "—";

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

  // One grid for the whole table, not a flex row per line. Flex rows size their
  // columns independently, so a header whose text runs wider than the column
  // minimum ("Interc %" at 48px against a 44px floor) pushed that row's cells
  // out of step with the body's — values visibly starting left of their
  // headers. As a single grid the columns are shared by construction, and
  // `max-content` lets the widest cell in a column — header or body — set it.
  const cols = [
    "minmax(0, 1fr)",
    `minmax(${VALUE_MIN}, max-content)`,
    ...(hasShare ? [`minmax(${PCT_MIN}, max-content)`] : []),
    ...(hasSubset ? [`minmax(${SUBSET_MIN}, max-content)`] : []),
    ...(hasSubsetRate ? [`minmax(${PCT_MIN}, max-content)`] : []),
    ...(hasProjected ? [`minmax(${PROJ_MIN}, max-content)`] : []),
    ...(hasTrend ? [`minmax(${TREND_MIN}, max-content)`] : []),
  ].join(" ");

  const num: React.CSSProperties = {
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    padding: "1px 0",
  };
  const showHeader = hasShare || hasSubset || hasSubsetRate || hasTrend || hasProjected;

  return (
    <div style={{ display: "grid", gridTemplateColumns: cols, columnGap: GAP, alignItems: "baseline" }}>
      {showHeader && (
        <div style={{ display: "contents", color: t.textMuted }}>
          <span />
          <HeaderCell>Value</HeaderCell>
          {hasShare && <HeaderCell>{shareLabel}</HeaderCell>}
          {hasSubset && <HeaderCell>{subsetLabel}</HeaderCell>}
          {hasSubsetRate && <HeaderCell>{subsetLabel} %</HeaderCell>}
          {hasProjected && <HeaderCell>Projected</HeaderCell>}
          {hasTrend && <HeaderCell>Trend</HeaderCell>}
          <div style={{ gridColumn: "1 / -1", borderBottom: `1px solid ${t.border}`, marginBottom: 3 }} />
        </div>
      )}
      {rows.map((r, i) => {
        const rate = hasSubsetRate ? subsetRate(r) : null;
        return (
          <div key={i} style={{
            display: "contents",
            color: r.color,
            fontWeight: r.emphasis === "bold" ? 700 : 400,
          }}>
            {r.separatorAbove && (
              <div style={{ gridColumn: "1 / -1", borderTop: `1px solid ${t.border}`, margin: "3px 0" }} />
            )}
            <span style={{
              minWidth: 0, padding: "1px 0",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {r.label}
            </span>
            <span style={{ ...num, color: t.text, fontWeight: 700 }}>
              {renderCell(r.value, formatValue, VALUE_EMPTY)}
            </span>
            {hasShare && <span style={{ ...num, color: t.textMuted }}>{fmtPct(r.share)}</span>}
            {hasSubset && (
              <span style={{ ...num, color: t.textMuted }}>
                {renderCell(r.subset, formatValue, "")}
              </span>
            )}
            {hasSubsetRate && <span style={{ ...num, color: t.textMuted }}>{fmtPct(rate)}</span>}
            {hasProjected && (
              <span style={{ ...num, color: t.textMuted }}>
                {r.projected != null ? formatValue(r.projected) : ""}
              </span>
            )}
            {hasTrend && (
              <span style={{ ...num, color: t.muted }}>
                {r.trend != null ? trendFmt(r.trend) : ""}
              </span>
            )}
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
  return entries.map((e, i) => {
    // An entry upstream withheld carries a placeholder 0. Say so rather than
    // print it — and leave the subset/share cells empty, since a rate over a
    // number nobody published would be fiction.
    if (e.undisclosed) {
      return {
        label: e.model,
        color,
        value: <span style={{ fontSize: "0.917em", opacity: 0.75 }}>not disclosed</span>,
        separatorAbove: i === 0,
      };
    }
    return {
      label: e.model,
      color,
      value: e.launched,
      subset: e.intercepted,
      share: hasShare ? (e.launched / total) * 100 : undefined,
      separatorAbove: i === 0,
    };
  });
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

// ── Descriptors ─────────────────────────────────────────────────────────────
//
// A chart describes one x-position's tooltip as data, not JSX, so the same
// description can be rendered two ways: as the floating hover card, and as
// the body of the pinned bottom sheet (see ChartSheet). Charts return a
// descriptor from a `describe(x)` function; the two renderers below are the
// only places that turn one into elements.

export interface TooltipDescriptor {
  /** Usually the formatted date. The sheet lifts this into its own header
   *  (next to the ‹ › stepper) rather than rendering it inline. */
  header?: ReactNode;
  rows: TooltipTableRow[];
  /** Prose below the table — warning notes, caveats. */
  footer?: ReactNode;
  subsetLabel?: string;
  shareLabel?: string;
  formatValue?: (n: number) => string;
  formatTrend?: (n: number) => string;
  /** Hover-card minimum width. Ignored by the sheet, which is viewport-wide. */
  minWidth?: number;
  /** Escape hatch for a tooltip that genuinely isn't a row table — the hourly
   *  overlay's multi-column grid of dates, for instance, which as a single
   *  column would be thirty rows tall. When set it replaces the table in both
   *  renderers, and `rows` is ignored. */
  content?: ReactNode;
  /** Sheet-only. Rendered in place of the table when `rows` is empty — a
   *  pinned sheet that says nothing reads as broken, whereas an empty hover
   *  tooltip is just silence the reader didn't ask for. */
  emptyState?: ReactNode;
}

/** Floating hover rendering. Null when there is genuinely nothing to say —
 *  no rows and no note — which is how gap dates stay silent on hover. */
export function DescriptorCard({ d }: { d: TooltipDescriptor | null }) {
  if (!d) return null;
  if (d.content == null && d.rows.length === 0 && d.footer == null) return null;
  return (
    <TooltipCard header={d.header} footer={d.footer} minWidth={d.minWidth}>
      {d.content ?? (d.rows.length > 0 && (
        <TooltipTable
          rows={d.rows}
          formatValue={d.formatValue}
          formatTrend={d.formatTrend}
          shareLabel={d.shareLabel}
          subsetLabel={d.subsetLabel}
        />
      ))}
    </TooltipCard>
  );
}

/** Sheet-body rendering: no card chrome (the sheet supplies it), no inline
 *  header (the sheet's own header carries the date), and `emptyState` honoured
 *  so a no-data date explains itself. */
export function DescriptorBody({ d }: { d: TooltipDescriptor | null }) {
  const { theme: t } = useTheme();
  if (!d) return null;
  if (d.content != null) return <>{d.content}{d.footer}</>;
  if (d.rows.length === 0) {
    return (
      <>
        {d.emptyState != null && (
          <div style={{ color: t.textMuted }}>{d.emptyState}</div>
        )}
        {d.footer}
      </>
    );
  }
  return (
    <>
      <TooltipTable
        rows={d.rows}
        formatValue={d.formatValue}
        formatTrend={d.formatTrend}
        shareLabel={d.shareLabel}
        subsetLabel={d.subsetLabel}
      />
      {d.footer}
    </>
  );
}
