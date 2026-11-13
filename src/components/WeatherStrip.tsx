import { useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabaseWeather } from "@/hooks/useDatabaseWeather";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { chartAnchor } from "@/utils/chartAnchor";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { buildStrip, describeCell, type StripCell } from "@/utils/weatherStrip";
import { DEGRADED, SEVERE } from "@/utils/weatherRating";

const TITLE = "Front-line weather — drone conditions";
const ANCHOR = chartAnchor(TITLE);
// Forecast hours are drawn at this opacity: the same colour, less certain.
const FORECAST_OPACITY = 0.45;

// One full-width card above the SBS hourly charts: for the day being viewed
// (the picked end date, or today), how limited small drones were at each GSUA
// direction, hour by hour, on the same 0–23 clock the charts run on.
//
// Auxiliary by design: it loads its own DB, never holds up the page, and on
// any failure shrinks to one line rather than an error state.
export function WeatherStrip({ date }: { date: string }) {
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const { loadState, error, queryDay } = useDatabaseWeather();
  const [picked, setPicked] = useState<{ sector: string; cell: StripCell } | null>(null);

  // queryDay is rebuilt when a background refresh swaps the DB in.
  const day = useMemo(
    () => (loadState === "ready" ? queryDay(date) : null),
    [loadState, queryDay, date],
  );
  const model = useMemo(() => (day ? buildStrip(day.sectors, day.cells) : null), [day]);

  const levelColor = (level: number) =>
    level === SEVERE ? c.weatherSevere : level === DEGRADED ? c.weatherDegraded : c.weatherOk;
  const mono: React.CSSProperties = { fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted };

  let body: React.ReactNode;
  if (error) {
    body = <div style={mono}>Weather data unavailable.</div>;
  } else if (!model) {
    body = <div style={mono}>Loading weather…</div>;
  } else if (!model.hasData) {
    body = <div style={mono}>No weather data for {date}.</div>;
  } else {
    const n = model.rows.length;
    const anyForecast = model.rows.some((r) => r.cells.some((x) => x.forecast));
    body = (
      <>
        <div style={{ ...mono, marginBottom: 8 }}>
          {date} · drones POOR at {model.poorSectors} of {n} directions
          {day?.asOf && <> · as of {day.asOf.slice(11, 16)} UTC</>}
        </div>
        <div
          role="grid"
          aria-label={`${TITLE}, ${date}`}
          style={{
            display: "grid",
            // The name column gives way on a phone (ellipsis, full name in
            // the tooltip) so the 24 hours keep a usable width.
            gridTemplateColumns: "clamp(64px, 22vw, 150px) repeat(24, minmax(0, 1fr)) 58px",
            gap: 2, alignItems: "center", ...mono,
          }}
        >
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            // Every 6 h, left-aligned on its hour and free to overflow into
            // the next cells — three-hourly labels run together on a phone.
            <div key={h} style={{ whiteSpace: "nowrap", overflow: "visible" }}>
              {h % 6 === 0 ? `${String(h).padStart(2, "0")}:00` : ""}
            </div>
          ))}
          <div style={{ paddingLeft: 6 }}>DAY</div>

          {/* How many directions were severely limited each hour — the row to
              read against the SBS hourly lines below. */}
          <div title="Directions where small drones were severely limited that hour">severe</div>
          {model.severeCount.map((k, h) => (
            <div key={h} data-testid="weather-severe-count" style={{
              textAlign: "center", borderRadius: 2, height: 14, lineHeight: "14px",
              background: k ? c.weatherSevere : "transparent",
              opacity: k ? 0.25 + 0.75 * (k / n) : 1,
              color: k ? "#fff" : t.textFaint,
            }}>{k || "·"}</div>
          ))}
          <div />

          {model.rows.map((row) => (
            <div key={row.sector.id} role="row" data-sector={row.sector.key} style={{ display: "contents" }}>
              <div title={row.sector.near} style={{
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: t.text,
              }}>{row.sector.key}</div>
              {row.cells.map((cell) => (
                <div
                  key={cell.hour}
                  role="gridcell"
                  data-level={cell.rating?.level ?? ""}
                  data-forecast={cell.forecast ? "1" : undefined}
                  title={describeCell(row.sector.key, cell)}
                  onMouseEnter={() => setPicked({ sector: row.sector.key, cell })}
                  onClick={() => setPicked({ sector: row.sector.key, cell })}
                  style={{
                    height: 14, borderRadius: 2, cursor: "pointer",
                    background: cell.rating ? levelColor(cell.rating.level) : "transparent",
                    border: cell.rating ? "none" : `1px dashed ${t.chartGrid}`,
                    opacity: cell.forecast ? FORECAST_OPACITY : 1,
                  }}
                />
              ))}
              <div data-testid="weather-day" style={{
                paddingLeft: 6,
                color: row.day === "POOR" ? c.weatherSevere : row.day === "MARGINAL" ? t.text : t.textMuted,
                fontWeight: row.day === "POOR" ? 700 : 400,
              }}>{row.day ?? "–"}</div>
            </div>
          ))}
        </div>

        <div style={{ ...mono, marginTop: 8, minHeight: 14, color: picked ? t.text : t.textMuted }}>
          {picked ? describeCell(picked.sector, picked.cell) : "Hover or tap an hour for its weather."}
        </div>
        <div style={{ ...mono, marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          {([["ok", c.weatherOk], ["limited", c.weatherDegraded], ["severely limited", c.weatherSevere]] as const)
            .map(([label, color]) => (
              <span key={label} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
                {label}
              </span>
            ))}
          {anyForecast && <span>faded = forecast</span>}
          <span>
            Open-Meteo model data, not observations. Small-drone conditions (wind, rain, fog, icing, cold) —
            a heuristic, not a record of flights.
          </span>
        </div>
      </>
    );
  }

  return (
    <div className="weather-card" id={ANCHOR} data-testid="weather-strip" style={{
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: "1 / -1",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <ChartCardTitle title={TITLE} anchor={ANCHOR} marginBottom={6} />
      {body}
    </div>
  );
}
