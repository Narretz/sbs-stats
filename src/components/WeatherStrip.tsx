import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabaseWeather } from "@/hooks/useDatabaseWeather";
import { useChartPin } from "@/hooks/ChartPinProvider";
import { useDrillDownLink, type SheetLink } from "@/hooks/useDrillDownLink";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { chartAnchor } from "@/utils/chartAnchor";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { ChartSheetContent } from "@/components/ChartSheet";
import { DescriptorBody, DescriptorCard, type TooltipDescriptor } from "@/components/TooltipTable";
import { DEGRADED, SEVERE, type Level } from "@/utils/weatherRating";
import { buildDailyStrip, buildHourlyStrip, datesBetween, dayLevel } from "@/utils/weatherStrip";
import {
  dayCellDescriptor, dayColumnDescriptor, hourCellDescriptor, hourColumnDescriptor, weekdayDate,
  type DescriptorColors,
} from "@/utils/weatherDescriptors";

// One title for both strips, so the daily strip's sheet link lands on the
// hourly strip of the same day (same anchor).
const TITLE = "Front-line weather — drone conditions";
const ANCHOR = chartAnchor(TITLE);
// Forecast hours (and days that include some) are drawn at this opacity.
const FORECAST_OPACITY = 0.45;

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
  tailStrong: boolean;
}

interface GridProps {
  subtitle: ReactNode;
  columns: { key: string | number; axis: string }[];
  rows: GridRow[];
  count: { label: string; title: string; values: number[] };
  /** Header of the column at the row ends. */
  tailHeader: string;
  legend: [string, string][];
  cellDescriptor: (row: number, col: number) => TooltipDescriptor;
  columnDescriptor: (col: number) => TooltipDescriptor;
  columnLabel: (col: number) => string;
  link?: (col: number) => SheetLink | null;
}

function StripGrid({ subtitle, columns, rows, count, tailHeader, legend, cellDescriptor, columnDescriptor, columnLabel, link }: GridProps) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const keys = useMemo(() => columns.map((x) => x.key), [columns]);
  const pin = useChartPin(ANCHOR, keys);
  const [hover, setHover] = useState<{ row: number | null; col: number; x: number; y: number } | null>(null);

  const levelColor = (l: Level) => (l === SEVERE ? c.weatherSevere : l === DEGRADED ? c.weatherDegraded : c.weatherOk);
  const n = columns.length;
  // A long window squeezes the cells; drop the gaps before the cells vanish.
  const gap = n > 60 ? 0 : n > 31 ? 1 : 2;
  const mono: React.CSSProperties = { fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted };

  // The hover card is for a pointer that can hover — a mouse or a pen — as on
  // the charts (usePinnedChart). Touch gets the sheet, on tap.
  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === "touch") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
    if (!el) { setHover(null); return; }
    const row = el.dataset.row != null && el.dataset.row !== "" ? Number(el.dataset.row) : null;
    setHover({ row, col: Number(el.dataset.col), x: e.clientX, y: e.clientY });
  }, []);
  const onClick = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
    if (el) pin.select(keys[Number(el.dataset.col)]);
  }, [pin, keys]);

  const pinnedCol = pin.isPinned ? pin.index : -1;
  const ring = (col: number): React.CSSProperties =>
    col === pinnedCol ? { outline: `1.5px solid ${t.text}`, outlineOffset: -1 } : {};

  const card = hover && !pin.isPinned ? (
    <div style={{
      position: "fixed", zIndex: 9999, pointerEvents: "none",
      left: hover.x + 14, top: hover.y + 14,
      // Hang it on whichever side of the cursor has room.
      transform: `translate(${hover.x > window.innerWidth - 320 ? "calc(-100% - 28px)" : "0"}, ${hover.y > window.innerHeight * 0.55 ? "calc(-100% - 28px)" : "0"})`,
    }}>
      <DescriptorCard d={hover.row == null ? columnDescriptor(hover.col) : cellDescriptor(hover.row, hover.col)} />
    </div>
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
          gridTemplateColumns: `clamp(64px, 22vw, 150px) repeat(${n}, minmax(0, 1fr)) 58px`,
          columnGap: gap, rowGap: 2, alignItems: "center", ...mono,
        }}
      >
        <div />
        {columns.map((col, i) => (
          // Left-aligned on its column and free to overflow into the next.
          <div key={i} style={{ whiteSpace: "nowrap", overflow: "visible", color: i === pinnedCol ? t.text : undefined }}>
            {col.axis}
          </div>
        ))}
        <div style={{ paddingLeft: 6 }}>{tailHeader}</div>

        <div title={count.title}>{count.label}</div>
        {count.values.map((k, i) => (
          <div key={i} data-col={i} data-row="" data-testid="weather-count" style={{
            textAlign: "center", borderRadius: 2, height: 14, lineHeight: "14px", cursor: "pointer",
            overflow: "hidden",
            background: k ? c.weatherSevere : "transparent",
            opacity: k ? 0.25 + 0.75 * (k / rows.length) : 1,
            color: k ? "#fff" : t.textFaint,
            ...ring(i),
          }}>{n <= 31 ? (k || "·") : ""}</div>
        ))}
        <div />

        {rows.map((row, r) => (
          <div key={row.key} role="row" data-sector={row.key} style={{ display: "contents" }}>
            <div title={row.title} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: t.text }}>
              {row.label}
            </div>
            {row.cells.map((cell, i) => (
              <div
                key={i}
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
            ))}
            <div data-testid="weather-tail" style={{
              paddingLeft: 6, whiteSpace: "nowrap",
              color: row.tailStrong ? c.weatherSevere : t.textMuted,
              fontWeight: row.tailStrong ? 700 : 400,
            }}>{row.tail}</div>
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
        <span>faded = forecast</span>
        <span>Hover for details, click for every direction. Open-Meteo model data, not observations — a heuristic, not a record of flights.</span>
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
  const style = { fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted };
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
  // queryRange is rebuilt when a background refresh swaps the DB in.
  const data = useMemo(() => (loadState === "ready" ? queryRange(date, date) : null), [loadState, queryRange, date]);
  const strip = useMemo(() => (data ? buildHourlyStrip(data.sectors, data.cells) : null), [data]);
  const status = useStatusLine(error, !!strip, !!strip?.hasData, `No weather data for ${date}.`);
  const columns = useMemo(() => Array.from({ length: 24 }, (_, h) => ({
    key: h, axis: h % 6 === 0 ? `${String(h).padStart(2, "0")}:00` : "",
  })), []);

  return (
    <StripCard>
      {status ?? (strip && (
        <StripGrid
          subtitle={`${date} · drones POOR at ${strip.poorSectors} of ${strip.rows.length} directions${asOfText(data!.asOf)}`}
          columns={columns}
          rows={strip.rows.map((r) => ({
            key: r.sector.key, label: r.sector.key, title: r.sector.near,
            cells: r.cells.map((x) => ({ level: x.rating?.level ?? null, faded: x.forecast })),
            tail: r.day ?? "–", tailStrong: r.day === "POOR",
          }))}
          count={{ label: "Σ severe", title: "How many directions had small drones severely limited in this hour", values: strip.severeCount }}
          tailHeader="DAY"
          legend={[["ok", c.weatherOk], ["limited", c.weatherDegraded], ["severely limited", c.weatherSevere]]}
          cellDescriptor={(r, h) => hourCellDescriptor(strip.rows[r].sector.key, date, strip.rows[r].cells[h], colors)}
          columnDescriptor={(h) => hourColumnDescriptor(strip, date, h, colors)}
          columnLabel={(h) => `${date} ${String(h).padStart(2, "0")}:00`}
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
  const data = useMemo(
    () => (loadState === "ready" ? queryRange(startDate, endDate) : null),
    [loadState, queryRange, startDate, endDate],
  );
  const dates = useMemo(() => datesBetween(startDate, endDate), [startDate, endDate]);
  const strip = useMemo(() => (data ? buildDailyStrip(data.sectors, data.cells, dates) : null), [data, dates]);
  const status = useStatusLine(error, !!strip, !!strip?.hasData, `No weather data for ${startDate} – ${endDate}.`);
  // About seven labels across, whatever the window.
  const every = Math.max(1, Math.ceil(dates.length / 7));
  const columns = useMemo(() => dates.map((d, i) => ({ key: d, axis: i % every === 0 ? d.slice(5) : "" })), [dates, every]);

  return (
    <StripCard>
      {status ?? (strip && (
        <StripGrid
          subtitle={`${startDate} – ${endDate} · ${strip.poorCount.reduce((a, b) => a + b, 0)} direction-days with drones POOR${asOfText(data!.asOf)}`}
          columns={columns}
          rows={strip.rows.map((r) => {
            const poor = r.cells.filter((x) => x.summary?.rating === "POOR").length;
            return {
              key: r.sector.key, label: r.sector.key, title: r.sector.near,
              cells: r.cells.map((x) => ({
                level: x.summary ? dayLevel(x.summary.rating) : null,
                faded: (x.summary?.forecastHours ?? 0) > 0,
              })),
              tail: `${poor} d`, tailStrong: poor > 0,
            };
          })}
          count={{ label: "Σ POOR", title: "How many directions had a POOR day for small drones", values: strip.poorCount }}
          tailHeader="POOR"
          legend={[["GOOD", c.weatherOk], ["MARGINAL", c.weatherDegraded], ["POOR", c.weatherSevere]]}
          cellDescriptor={(r, i) => dayCellDescriptor(strip.rows[r].sector.key, strip.rows[r].cells[i], colors)}
          columnDescriptor={(i) => dayColumnDescriptor(strip, i, colors)}
          columnLabel={(i) => weekdayDate(dates[i])}
          // The same strip, hour by hour, on the site's hourly page where it has one.
          link={drillDown ? (i) => drillDown(dates[i], ANCHOR) : undefined}
        />
      ))}
    </StripCard>
  );
}
