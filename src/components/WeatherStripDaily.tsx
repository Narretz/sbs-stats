import { useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabaseWeather } from "@/hooks/useDatabaseWeather";
import { useDrillDownLink } from "@/hooks/useDrillDownLink";
import { getKyivDateString } from "@/hooks/sqlLoader";
import { chartColors } from "@/chartColors";
import { StripCard } from "@/components/WeatherStripCard";
import { StripGrid } from "@/components/WeatherStripGrid";
import { asOfText, FCST_AXIS, LEGEND, STRIP_ANCHOR, STRIP_TITLE, stripStatus, useDescriptorColors } from "@/components/weatherStripShared";
import { buildDailyStrip, dateAxisLabels, datesBetween, dayLevel, forecastDayAfter } from "@/utils/weatherStrip";
import { dayCellDescriptor, dayColumnDescriptor, weekdayDate } from "@/utils/weatherDescriptors";

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
  const status = stripStatus(error, !!strip, !!strip?.hasData, `No weather data for ${startDate} – ${endDate}.`);
  const columns = useMemo(() => {
    const labels = dateAxisLabels(nWindow);
    return (strip?.dates ?? []).map((d, i) => i < nWindow
      ? { key: d, axis: labels[i] ? d.slice(5) : "", thinAxis: labels[i] === "thin" }
      : { key: d, axis: FCST_AXIS, forecast: true });
  }, [strip, nWindow]);

  return (
    <StripCard status={status}>
      {strip && (
        <StripGrid
          id={STRIP_ANCHOR}
          title={STRIP_TITLE}
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
          link={drillDown ? (i) => (i < nWindow ? drillDown(strip.dates[i], STRIP_ANCHOR) : null) : undefined}
        />
      )}
    </StripCard>
  );
}
