import { Fragment, useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useChartPin } from "@/hooks/ChartPinProvider";
import type { SheetLink } from "@/hooks/useDrillDownLink";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { ChartSheetContent } from "@/components/ChartSheet";
import { DescriptorBody, DescriptorCard, type TooltipDescriptor } from "@/components/TooltipTable";
import { FloatingCard } from "@/components/FloatingCard";
import { DEGRADED, SEVERE, type Level } from "@/utils/weatherRating";
import { cellGap } from "@/utils/weatherStrip";

// The grid both weather strips are drawn with: a row per direction, a cell per
// column (hours or days) coloured by level, a count row above and a summary
// column at the end. Knows nothing about hours or days — the strips
// (WeatherStripHourly / WeatherStripDaily) hand it columns, rows and the
// descriptors behind them.
//
// Not a recharts chart, so it takes part in the charts' tooltip and pinned
// sheet through their lower-level parts: the same DescriptorCard as a
// floating hover card (one direction), and useChartPin + ChartSheetContent
// for the sheet (the whole column, every direction), with the sheet's stepper
// walking the columns.

// Forecast hours (and days that include some) are drawn at this opacity.
const FORECAST_OPACITY = 0.5;

export interface GridRow {
  key: string;
  label: string;
  title: string;
  cells: { level: Level | null; faded: boolean }[];
  tail: string;
  /** Draws `tail` in the strip's red, bold. */
  tailStrong: boolean;
  /** Plain text after `tail`, never highlighted — the "/30" of "4/30". */
  tailSuffix?: string;
  tailTitle?: string;
}

export interface GridProps {
  /** The pin's identity and the card's anchor — the strip card's id. */
  id: string;
  /** Names the grid, and heads the sheet. */
  title: string;
  subtitle: ReactNode;
  /** `forecast`: a column that is forecast through and through (the daily
   *  strip's tomorrow) — set a little apart from the ones before it. */
  columns: { key: string | number; axis: ReactNode; forecast?: boolean; thinAxis?: boolean }[];
  /** A bar above the header over the first `progress` columns, in the
   *  charts' main-series blue — how far the page's own data has got (the
   *  SBS hourly page: up to its latest hour). */
  progress?: { columns: number; title: string };
  rows: GridRow[];
  count: { label: string; title: string; values: number[] };
  /** Header of the column at the row ends. */
  tailHeader: string;
  legend: [string, string][];
  /** How a cell's level is arrived at, after the swatches. */
  legendNote?: string;
  cellDescriptor: (row: number, col: number) => TooltipDescriptor;
  columnDescriptor: (col: number) => TooltipDescriptor;
  columnLabel: (col: number) => string;
  link?: (col: number) => SheetLink | null;
}

export function StripGrid({ id, title, subtitle, columns, progress, rows, count, tailHeader, legend, legendNote, cellDescriptor, columnDescriptor, columnLabel, link }: GridProps) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const keys = useMemo(() => columns.map((x) => x.key), [columns]);
  const pin = useChartPin(id, keys);
  const [hover, setHover] = useState<{ row: number | null; col: number; x: number; y: number } | null>(null);

  const levelColor = (l: Level) => (l === SEVERE ? c.weatherSevere : l === DEGRADED ? c.weatherDegraded : c.weatherOk);
  const mono: React.CSSProperties = { fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted };

  // The hover card is for a pointer that can hover — a mouse or a pen — as on
  // the charts (usePinnedChart). Touch gets the sheet, on tap.
  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === "touch") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
    if (!el) {
      // The gaps between cells belong to the grid itself (its rows are
      // display: contents, so nothing else is there) — or to the spacer
      // before a forecast column. Crossing one keeps the
      // last cell's card, following the pointer, rather than blinking it out
      // between every two cells. Over anything else — a name, the last
      // column, the labels — it closes.
      if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.gap != null) {
        setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h));
      } else {
        setHover(null);
      }
      return;
    }
    const row = el.dataset.row != null && el.dataset.row !== "" ? Number(el.dataset.row) : null;
    setHover({ row, col: Number(el.dataset.col), x: e.clientX, y: e.clientY });
  }, []);
  const onClick = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
    if (el) pin.select(keys[Number(el.dataset.col)]);
  }, [pin, keys]);

  const pinnedCol = pin.isPinned ? pin.index : -1;
  // A forecast column stands a little apart: a narrow empty track of its own
  // before it, with an empty spacer in every row to fill it. Not a margin on
  // the cells — that is taken out of the column's own track, and the forecast
  // cells came out narrower than the rest.
  const spacer = (col: number) => (columns[col].forecast ? <div data-gap="" aria-hidden /> : null);
  // The widths that give way on a narrow screen are CSS variables, set on
  // .weather-grid in theme.css.
  const tracks = columns.map((col) => `${col.forecast ? "var(--wx-fcst-gap) " : ""}minmax(0, 1fr)`).join(" ");
  // Grid line a column starts at: after the name column and every forecast
  // spacer up to and including its own.
  const line = (col: number) => 2 + col + columns.slice(0, col + 1).filter((x) => x.forecast).length;
  // Forecast columns come last.
  const lastPlain = columns.filter((x) => !x.forecast).length - 1;
  // A long window squeezes the cells — sooner on a narrow screen; drop the
  // gaps before the cells vanish. Both widths' gaps go to CSS
  // (.weather-grid picks one by media query), and a cell's corners round
  // only with a gap to show them.
  const gaps = { "--wx-gap-wide": `${cellGap(lastPlain + 1, false)}px`, "--wx-gap-narrow": `${cellGap(lastPlain + 1, true)}px` };
  // Grid rows: the progress bar's (if any), the header, Σ, then the directions.
  const countRow = progress && progress.columns > 0 ? 3 : 2;

  const card = hover && !pin.isPinned ? (
    <FloatingCard x={hover.x} y={hover.y}>
      <DescriptorCard d={hover.row == null ? columnDescriptor(hover.col) : cellDescriptor(hover.row, hover.col)} />
    </FloatingCard>
  ) : null;

  return (
    <>
      <div style={{ ...mono, marginBottom: 8 }}>{subtitle}</div>
      {/* The pin's measuring ref, and the marker that keeps a click here from
          reading as a click outside the open sheet. */}
      <div {...pin.cardProps}>
      <div
        role="grid"
        className="weather-grid"
        aria-label={title}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onClick={onClick}
        style={{
          display: "grid", position: "relative",
          // The name column gives way on a phone (ellipsis, full name in the
          // tooltip) so the cells keep a usable width.
          gridTemplateColumns: `var(--wx-name) ${tracks} minmax(var(--wx-tail-min), max-content)`,
          rowGap: 2, alignItems: "center", ...mono, ...gaps,
        }}
      >
        {/* A row of its own above the header, on explicit columns. */}
        {progress && progress.columns > 0 && (
          <div data-testid="weather-progress" title={progress.title} style={{
            gridColumn: `2 / ${line(progress.columns - 1) + 1}`, alignSelf: "end",
            height: 3, borderRadius: 1, marginBottom: 2, background: c.hourlyToday,
          }} />
        )}
        <div style={{ gridColumn: 1 }} />
        {columns.map((col, i) => (
          <Fragment key={i}>
            {spacer(i)}
            {/* Left-aligned on its column and free to overflow into the next. */}
            <div
              className={[col.thinAxis && "weather-axis-thin", col.forecast && "weather-axis-fcst", i === lastPlain && "weather-axis-last"].filter(Boolean).join(" ") || undefined}
              style={{ whiteSpace: "nowrap", fontSize: 10, overflow: "visible", color: i === pinnedCol ? t.text : undefined }}
            >
              {/* The last label ends at its column, where it is wider than that
                  (a container query): spilling on, it would run into "fcst". */}
              {i === lastPlain ? <div className="weather-axis-end">{col.axis}</div> : col.axis}
            </div>
          </Fragment>
        ))}
        <div className="weather-tail" style={{ fontSize: 10 }}>{tailHeader}</div>

        <div title={count.title}>{count.label}</div>
        {count.values.map((k, i) => (
          <Fragment key={i}>
          {spacer(i)}
          {/* The number shows only while the cell is wide enough for two
              digits (a container query on .weather-count). */}
          <div data-col={i} data-row="" data-testid="weather-count" className="weather-count" style={{
            textAlign: "center", borderRadius: 2, height: 14, lineHeight: "14px", cursor: "pointer",
            overflow: "hidden",
            background: k ? c.weatherSevere : "transparent",
            opacity: k ? 0.25 + 0.75 * (k / rows.length) : 1,
            color: k ? "#fff" : t.textFaint,
            ...(columns[i].forecast && k ? { opacity: (0.25 + 0.75 * (k / rows.length)) * FORECAST_OPACITY } : null),
          }}><span className="weather-count-n">{k || "·"}</span></div>
          </Fragment>
        ))}
        <div />

        {/* The pinned column: a vertical line through its centre, as the
            charts' pinned cursor, from Σ to the last direction. Absolutely
            positioned, so it takes no cell of its own from the grid. */}
        {pinnedCol >= 0 && (
          <div data-testid="weather-pin-line" aria-hidden style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            gridColumn: `${line(pinnedCol)} / span 1`, gridRow: `${countRow} / ${countRow + 1 + rows.length}`,
          }}>
            {/* A border, not a 1.5px-wide background: a fractional width at a
                fractional x snaps to 1 device pixel in one column, 2 in the
                next; a border's width is rounded once, the same everywhere. */}
            <div style={{ position: "absolute", top: 0, bottom: 0, left: "calc(50% - var(--wx-pin-w) / 2)", borderLeft: `var(--wx-pin-w) solid ${c.pinnedCursor}` }} />
          </div>
        )}
        {rows.map((row, r) => (
          <div key={row.key} role="row" data-sector={row.key} style={{ display: "contents" }}>
            <div title={row.title} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: t.text }}>
              {row.label}
            </div>
            {row.cells.map((cell, i) => (
              <Fragment key={i}>
              {spacer(i)}
              <div
                role="gridcell"
                data-row={r}
                data-col={i}
                data-level={cell.level ?? ""}
                data-forecast={cell.faded ? "1" : undefined}
                style={{
                  height: 14, borderRadius: "min(var(--wx-gap) * 2, 2px)", cursor: "pointer",
                  background: cell.level != null ? levelColor(cell.level) : "transparent",
                  border: cell.level != null ? "none" : `1px dashed ${t.chartGrid}`,
                  opacity: cell.faded ? FORECAST_OPACITY : 1,
                }}
              />
              </Fragment>
            ))}
            <div data-testid="weather-tail" className="weather-tail" title={row.tailTitle} style={{
              whiteSpace: "nowrap", color: t.textMuted,
            }}>
              <span style={row.tailStrong ? { color: c.weatherSevere, fontWeight: 700 } : undefined}>{row.tail}</span>
              {row.tailSuffix}
            </div>
          </div>
        ))}
      </div>
      </div>

      <div style={{ ...mono, marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {legend.map(([label, color]) => (
          <span key={label} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
            {label}
          </span>
        ))}
        {legendNote && <span>{legendNote}</span>}
        <span>faded = forecast</span>
        <span>Open-Meteo model data, not observations — drone conditions are a heuristic.</span>
      </div>

      {card}
      {pin.isPinned && (
        <ChartSheetContent
          title={title}
          label={columnLabel(pin.index)}
          canPrev={pin.canPrev}
          canNext={pin.canNext}
          onStep={pin.step}
          onClose={pin.clear}
          link={link ? link(pin.index) : null}
        >
          <DescriptorBody d={columnDescriptor(pin.index)} />
        </ChartSheetContent>
      )}
    </>
  );
}
