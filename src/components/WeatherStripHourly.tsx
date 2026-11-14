import { useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabaseWeather } from "@/hooks/useDatabaseWeather";
import { getKyivDateString } from "@/hooks/sqlLoader";
import { chartColors } from "@/chartColors";
import { StripCard } from "@/components/WeatherStripCard";
import { StripGrid } from "@/components/WeatherStripGrid";
import { asOfText, FCST_AXIS, LEGEND, STRIP_ANCHOR, STRIP_TITLE, stripStatus, useDescriptorColors } from "@/components/weatherStripShared";
import { buildDailyStrip, buildHourlyStrip, dayLevel, forecastDayAfter } from "@/utils/weatherStrip";
import { dayCellDescriptor, dayColumnDescriptor, hourCellDescriptor, hourColumnDescriptor, weekdayDate } from "@/utils/weatherDescriptors";

/** The SBS hourly page's strip: one day, hour by hour. Mount it only while
 *  the reader has the strip switched on — mounting is what fetches the DB. */
/** `sbsHour`: the latest hour the SBS figures for `date` have reached — the
 *  strip marks it with a bar above the hours. */
export function WeatherStripHourly({ date, sbsHour }: { date: string; sbsHour?: number | null }) {
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
  const status = stripStatus(error, !!strip, !!strip?.hasData, `No weather data for ${date}.`);

  const columns = useMemo(() => {
    const labelled = [0, 6, 12, 18, 23];
    return [
      ...Array.from({ length: 24 }, (_, h) => ({
        key: h as string | number,
        // The ":00" goes on a narrow screen, before the labels run together.
        axis: labelled.includes(h) ? <>{String(h).padStart(2, "0")}<span className="weather-axis-min">:00</span></> : "",
      })),
      ...(fc ? [{ key: fc.dates[0], axis: FCST_AXIS, forecast: true }] : []),
    ];
  }, [fc]);

  return (
    <StripCard status={status}>
      {strip && (
        <StripGrid
          id={STRIP_ANCHOR}
          title={STRIP_TITLE}
          subtitle={`${date} · a severe day for drones at ${strip.severeSectors} of ${strip.rows.length} directions${fc ? " · fcst = tomorrow's forecast" : ""}${asOfText(data!.asOf)}`}
          columns={columns}
          progress={sbsHour != null ? {
            columns: sbsHour + 1,
            title: `SBS figures up to ${String(sbsHour).padStart(2, "0")}:00`,
          } : undefined}
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
      )}
    </StripCard>
  );
}
