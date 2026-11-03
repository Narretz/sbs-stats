import { Rectangle } from "recharts";
import { entryOfDay, type SpannedDay } from "@/components/spanBarShape";

// The hover band for day bars (spanBarShape), widened over every day of the
// hovered day's entry, so the highlight covers the weekend bar rather than
// half of it. Pass as the chart's hover `cursor`: recharts clones it with the
// band it would have drawn for the hovered day (x, width) and the hovered
// index; everything else passes through. `bandFill` is the theme's hover band
// (chartColors hoverBand), under its own name: recharts' clone sets `fill` to
// its fixed #ccc, which would overwrite a `fill` passed here.
export function SpanCursor(props: { rows: readonly SpannedDay[]; bandFill?: string; x?: number; width?: number; payloadIndex?: number | string }) {
  const { rows, bandFill, x = 0, width = 0, payloadIndex: rawIndex = -1, ...rest } = props;
  // recharts 3 hands the index over as a string ("3"); arithmetic on that
  // concatenates ("3" + 1 = "31"), so read it as a number first.
  const payloadIndex = Number(rawIndex);
  const row = rows[payloadIndex];
  let first = payloadIndex, last = payloadIndex;
  if (row) {
    const entry = entryOfDay(row);
    while (first > 0 && entryOfDay(rows[first - 1]) === entry) first--;
    while (last < rows.length - 1 && entryOfDay(rows[last + 1]) === entry) last++;
  }
  return (
    <Rectangle {...rest} {...(bandFill ? { fill: bandFill } : null)}
      x={x - (payloadIndex - first) * width} width={width * (last - first + 1)} />
  );
}
