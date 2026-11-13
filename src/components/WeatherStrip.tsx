import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabaseWeather } from "@/hooks/useDatabaseWeather";
import { useChartPin } from "@/hooks/ChartPinProvider";
import { useDrillDownLink, type SheetLink } from "@/hooks/useDrillDownLink";
import { chartColors } from "@/chartColors";
import { getKyivDateString } from "@/hooks/sqlLoader";
import { FONTS } from "@/theme";
import { chartAnchor } from "@/utils/chartAnchor";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { ChartSheetContent } from "@/components/ChartSheet";
import { DescriptorBody, DescriptorCard, type TooltipDescriptor } from "@/components/TooltipTable";
import { DEGRADED, SEVERE, type Level } from "@/utils/weatherRating";
import { buildDailyStrip, buildHourlyStrip, datesBetween, dayLevel, forecastDayAfter } from "@/utils/weatherStrip";
import {
  dayCellDescriptor, dayColumnDescriptor, hourCellDescriptor, hourColumnDescriptor, weekdayDate,
  type DescriptorColors,
} from "@/utils/weatherDescriptors";

// One title for both strips, so the daily strip's sheet link lands on the
// hourly strip of the same day (same anchor).
const TITLE = "Front-line weather — drone conditions";
const ANCHOR = chartAnchor(TITLE);
// Forecast hours (and days that include some) are drawn at this opacity.
const FORECAST_OPACITY = 0.5;

// ── The grid, shared by both strips ─────────────────────────────────────────
//
// Not a recharts chart, so it takes part in the charts' tooltip and pinned
// sheet through their lower-level parts: the same DescriptorCard as a
// floating hover card (one direction), and useChartPin + ChartSheetContent
// for the sheet (the whole column, every direction), with the sheet's stepper
// walking the columns.

interface GridRow {
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

interface GridProps {
  subtitle: ReactNode;
  /** `forecast`: a column that is forecast through and through (the daily
   *  strip's tomorrow) — set a little apart from the ones before it. */
  columns: { key: string | number; axis: string; forecast?: boolean }[];
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

function StripGrid({ subtitle, columns, rows, count, tailHeader, legend, legendNote, cellDescriptor, columnDescriptor, columnLabel, link }: GridProps) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const keys = useMemo(() => columns.map((x) => x.key), [columns]);
  const pin = useChartPin(ANCHOR, keys);
  const [hover, setHover] = useState<{ row: number | null; col: number; x: number; y: number } | null>(null);

  const levelColor = (l: Level) => (l === SEVERE ? c.weatherSevere : l === DEGRADED ? c.weatherDegraded : c.weatherOk);
  const n = columns.length;
  // A long window squeezes the cells; drop the gaps before the cells vanish.
  const gap = n > 60 ? 0 : n > 31 ? 1 : 2;
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
  const tracks = columns.map((col) => `${col.forecast ? "3px " : ""}minmax(0, 1fr)`).join(" ");
  const ring = (col: number): React.CSSProperties =>
    col === pinnedCol ? { outline: `1.5px solid ${t.text}`, outlineOffset: -1 } : {};

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
        aria-label={TITLE}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onClick={onClick}
        style={{
          display: "grid",
          // The name column gives way on a phone (ellipsis, full name in the
          // tooltip) so the cells keep a usable width.
          gridTemplateColumns: `clamp(64px, 22vw, 150px) ${tracks} 58px`,
          columnGap: gap, rowGap: 2, alignItems: "center", ...mono,
        }}
      >
        <div />
        {columns.map((col, i) => (
          <Fragment key={i}>
            {spacer(i)}
            {/* Left-aligned on its column and free to overflow into the next. */}
            <div style={{ whiteSpace: "nowrap", fontSize: 10, overflow: "visible", color: i === pinnedCol ? t.text : undefined }}>
              {col.axis}
            </div>
          </Fragment>
        ))}
        <div style={{ paddingLeft: 6, fontSize: 10 }}>{tailHeader}</div>

        <div title={count.title}>{count.label}</div>
        {count.values.map((k, i) => (
          <Fragment key={i}>
          {spacer(i)}
          <div data-col={i} data-row="" data-testid="weather-count" style={{
            textAlign: "center", borderRadius: 2, height: 14, lineHeight: "14px", cursor: "pointer",
            overflow: "hidden",
            background: k ? c.weatherSevere : "transparent",
            opacity: k ? 0.25 + 0.75 * (k / rows.length) : 1,
            color: k ? "#fff" : t.textFaint,
            ...(columns[i].forecast && k ? { opacity: (0.25 + 0.75 * (k / rows.length)) * FORECAST_OPACITY } : null),
            ...ring(i),
          }}>{n <= 31 ? (k || "·") : ""}</div>
          </Fragment>
        ))}
        <div />

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
                  height: 14, borderRadius: gap ? 2 : 0, cursor: "pointer",
                  background: cell.level != null ? levelColor(cell.level) : "transparent",
                  border: cell.level != null ? "none" : `1px dashed ${t.chartGrid}`,
                  opacity: cell.faded ? FORECAST_OPACITY : 1,
                  ...ring(i),
                }}
              />
              </Fragment>
            ))}
            <div data-testid="weather-tail" title={row.tailTitle} style={{
              paddingLeft: 6, whiteSpace: "nowrap", color: t.textMuted, fontSize: 11
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
          title={TITLE}
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

// The hover card, placed by measuring it: beside the cursor where it fits,
// on the other side where it doesn't, and pushed back inside the viewport
// when neither side has room. Sized to its content (max-content): a fixed box
// placed at `left: x` is otherwise only as wide as the space between x and the
// viewport's edge, so hovering towards the right squeezed the card — and the
// label column of its table (minmax(0, 1fr)) went first, down to nothing.
const CARD_GAP = 14;
const CARD_MARGIN = 8;

function FloatingCard({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // On every move and every new content — the card's size follows what it
  // shows. Converges in one pass (the size doesn't depend on the position),
  // and the state update is skipped when nothing moved.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const place = (at: number, size: number, view: number) => {
      let p = at + CARD_GAP;
      if (p + size > view - CARD_MARGIN) p = at - CARD_GAP - size;
      if (p < CARD_MARGIN) p = Math.max(CARD_MARGIN, view - CARD_MARGIN - size);
      return Math.round(p);
    };
    const next = { left: place(x, w, vw), top: place(y, h, vh) };
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [x, y, children]);
  return (
    <div ref={ref} data-weather-hover="" style={{
      position: "fixed", zIndex: 9999, pointerEvents: "none",
      width: "max-content", maxWidth: `calc(100vw - ${2 * CARD_MARGIN}px)`,
      left: pos?.left ?? 0, top: pos?.top ?? 0,
      // Measured before it is shown, so it never paints in the wrong place.
      visibility: pos ? "visible" : "hidden",
    }}>
      {children}
    </div>
  );
}

// One scale, one legend, for hours and days alike.
const LEGEND = (c: { weatherOk: string; weatherDegraded: string; weatherSevere: string }): [string, string][] =>
  [["ok", c.weatherOk], ["limited", c.weatherDegraded], ["severe", c.weatherSevere]];

// ── The card shell and the two strips ───────────────────────────────────────

function StripCard({ children, cardProps }: { children: ReactNode; cardProps?: object }) {
  const { theme: t } = useTheme();
  return (
    <div className="weather-card" id={ANCHOR} data-testid="weather-strip" {...cardProps} style={{
      position: "relative",
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: "1 / -1",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <ChartCardTitle title={TITLE} anchor={ANCHOR} marginBottom={6} />
      {children}
    </div>
  );
}

// Row labels in the tooltip and sheet: severe in the strip's red, the rest in
// plain text — the "limited" pink is a fill colour, unreadable as text.
function useDescriptorColors(): DescriptorColors {
  const { theme: t } = useTheme();
  const severe = chartColors(t).weatherSevere;
  return useMemo(() => ({
    text: t.text,
    muted: t.textMuted,
    level: (l: Level) => (l === SEVERE ? severe : t.text),
  }), [t, severe]);
}

function useStatusLine(error: string | null, ready: boolean, hasData: boolean, empty: string): ReactNode | null {
  const { theme: t } = useTheme();
  const style = { fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted };
  if (error) return <div style={style}>Weather data unavailable.</div>;
  if (!ready) return <div style={style}>Loading weather…</div>;
  if (!hasData) return <div style={style}>{empty}</div>;
  return null;
}

const asOfText = (asOf: string | null) => (asOf ? ` · as of ${asOf.slice(0, 10)} ${asOf.slice(11, 16)} UTC` : "");

/** The SBS hourly page's strip: one day, hour by hour. Mount it only while
 *  the reader has the strip switched on — mounting is what fetches the DB. */
export function WeatherStripHourly({ date }: { date: string }) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const colors = useDescriptorColors();
  const { loadState, error, queryRange } = useDatabaseWeather();
  // Viewing today, one more column after hour 23: tomorrow as a whole day,
  // from the stored forecast — the same day rating as the daily strip's fcst
  // column. The DAY column stays today's.
  const extraDay = forecastDayAfter(date, getKyivDateString());
  // queryRange is rebuilt when a background refresh swaps the DB in.
  const data = useMemo(
    () => (loadState === "ready" ? queryRange(date, extraDay ?? date) : null),
    [loadState, queryRange, date, extraDay],
  );
  const strip = useMemo(
    () => (data ? buildHourlyStrip(data.sectors, data.cells.filter((x) => x.date === date)) : null),
    [data, date],
  );
  // Only with a forecast to show (a stale DB may have none).
  const fc = useMemo(() => {
    if (!data || !extraDay) return null;
    const day = buildDailyStrip(data.sectors, data.cells.filter((x) => x.date === extraDay), [extraDay]);
    return day.hasData ? day : null;
  }, [data, extraDay]);
  const status = useStatusLine(error, !!strip, !!strip?.hasData, `No weather data for ${date}.`);
  const columns = useMemo(() => [
    ...Array.from({ length: 24 }, (_, h) => ({
      key: h as string | number, axis: h % 6 === 0 ? `${String(h).padStart(2, "0")}:00` : "",
    })),
    ...(fc ? [{ key: fc.dates[0], axis: "fcst", forecast: true }] : []),
  ], [fc]);

  return (
    <StripCard>
      {status ?? (strip && (
        <StripGrid
          subtitle={`${date} · a severe day for drones at ${strip.severeSectors} of ${strip.rows.length} directions${fc ? " · fcst = tomorrow's forecast" : ""}${asOfText(data!.asOf)}`}
          columns={columns}
          rows={strip.rows.map((r, i) => {
            const tomorrow = fc?.rows[i].cells[0].summary;
            return {
              key: r.sector.key, label: r.sector.key, title: r.sector.near,
              cells: [
                ...r.cells.map((x) => ({ level: x.rating?.level ?? null, faded: x.forecast })),
                ...(fc ? [{ level: tomorrow ? dayLevel(tomorrow.rating) : null, faded: true }] : []),
              ],
              tail: r.day ?? "–", tailStrong: r.day === "severe",
              tailTitle: "The day as a whole: severe with ≥6 severe hours, limited with ≥6 limited ones",
            };
          })}
          count={{
            label: "Σ severe",
            title: "How many directions were severe for drones in this hour (fcst: had a severe day)",
            values: [...strip.severeCount, ...(fc ? fc.severeCount : [])],
          }}
          tailHeader="DAY"
          legend={LEGEND(c)}
          cellDescriptor={(r, h) => (h < 24
            ? hourCellDescriptor(strip.rows[r].sector.key, date, strip.rows[r].cells[h], colors)
            : dayCellDescriptor(fc!.rows[r].sector.key, fc!.rows[r].cells[0], colors))}
          columnDescriptor={(h) => (h < 24 ? hourColumnDescriptor(strip, date, h, colors) : dayColumnDescriptor(fc!, 0, colors))}
          columnLabel={(h) => (h < 24 ? `${date} ${String(h).padStart(2, "0")}:00` : `${weekdayDate(fc!.dates[0])} (forecast)`)}
        />
      ))}
    </StripCard>
  );
}

/** The daily pages' strip: the window's days. Mount only while switched on. */
export function WeatherStripDaily({ startDate, endDate }: { startDate: string; endDate: string }) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const colors = useDescriptorColors();
  const drillDown = useDrillDownLink();
  const { loadState, error, queryRange } = useDatabaseWeather();
  // A window ending today gets tomorrow as one extra column: the forecast the
  // hourly runs store to the end of tomorrow. Shown, never counted — the
  // severe-days column and the subtitle cover the window's own days.
  const extraDay = forecastDayAfter(endDate, getKyivDateString());
  const data = useMemo(
    () => (loadState === "ready" ? queryRange(startDate, extraDay ?? endDate) : null),
    [loadState, queryRange, startDate, endDate, extraDay],
  );
  const windowDates = useMemo(() => datesBetween(startDate, endDate), [startDate, endDate]);
  const nWindow = windowDates.length;
  const strip = useMemo(() => {
    if (!data) return null;
    const all = extraDay ? [...windowDates, extraDay] : windowDates;
    const s = buildDailyStrip(data.sectors, data.cells, all);
    // Only with a forecast to show — the extra column for a DB that has none
    // (a stale copy, a missed run) would be a column of gaps.
    if (all.length === nWindow || s.rows.some((r) => r.cells[nWindow].summary)) return s;
    return {
      ...s,
      dates: windowDates,
      rows: s.rows.map((r) => ({ ...r, cells: r.cells.slice(0, nWindow) })),
      severeCount: s.severeCount.slice(0, nWindow),
    };
  }, [data, windowDates, extraDay, nWindow]);
  const status = useStatusLine(error, !!strip, !!strip?.hasData, `No weather data for ${startDate} – ${endDate}.`);
  // About seven labels across, whatever the window.
  const every = Math.max(1, Math.ceil(nWindow / 7));
  const columns = useMemo(() => (strip?.dates ?? []).map((d, i) => i < nWindow
    ? { key: d, axis: i % every === 0 ? d.slice(5) : "" }
    : { key: d, axis: "fcst", forecast: true }), [strip, nWindow, every]);

  return (
    <StripCard>
      {status ?? (strip && (
        <StripGrid
          subtitle={`${startDate} – ${endDate} · ${strip.severeCount.slice(0, nWindow).reduce((a, b) => a + b, 0)} severe direction-days for drones${strip.dates.length > nWindow ? " · fcst = tomorrow's forecast, not counted" : ""}${asOfText(data!.asOf)}`}
          columns={columns}
          rows={strip.rows.map((r) => {
            const severe = r.cells.slice(0, nWindow).filter((x) => x.summary?.rating === "severe").length;
            return {
              key: r.sector.key, label: r.sector.key, title: r.sector.near,
              cells: r.cells.map((x) => ({
                level: x.summary ? dayLevel(x.summary.rating) : null,
                faded: (x.summary?.forecastHours ?? 0) > 0,
              })),
              // Severe days out of the window's days — the forecast day left out.
              tail: String(severe), tailSuffix: `/${nWindow}`, tailStrong: severe > 0,
              tailTitle: `${severe} of ${nWindow} days severe for drones`,
            };
          })}
          count={{ label: "Σ severe", title: "How many directions had a severe day for drones", values: strip.severeCount }}
          tailHeader="SEVERE"
          legend={LEGEND(c)}
          legendNote="A day is severe with ≥6 severe hours, limited likewise."
          cellDescriptor={(r, i) => dayCellDescriptor(strip.rows[r].sector.key, strip.rows[r].cells[i], colors)}
          columnDescriptor={(i) => dayColumnDescriptor(strip, i, colors)}
          columnLabel={(i) => `${weekdayDate(strip.dates[i])}${i >= nWindow ? " (forecast)" : ""}`}
          // The same strip, hour by hour, on the site's hourly page where it
          // has one — which stops at today, so not for the forecast day.
          link={drillDown ? (i) => (i < nWindow ? drillDown(strip.dates[i], ANCHOR) : null) : undefined}
        />
      ))}
    </StripCard>
  );
}
