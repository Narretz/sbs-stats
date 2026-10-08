import { Rectangle } from "recharts";
import { entryOfDay, type SpannedDay } from "@/components/spanBarShape";

// The hover band for day bars (spanBarShape), widened over every day of the
// hovered day's entry, so the highlight covers the weekend bar rather than
// half of it. Pass as the chart's hover `cursor`: recharts clones it with the
// band it would have drawn for the hovered day (x, width) and the hovered
// index; everything else passes through, so it looks the same.
export function SpanCursor(props: { rows: readonly SpannedDay[]; x?: number; width?: number; payloadIndex?: number }) {
  const { rows, x = 0, width = 0, payloadIndex = -1, ...rest } = props;
  const row = rows[payloadIndex];
  let first = payloadIndex, last = payloadIndex;
  if (row) {
    const entry = entryOfDay(row);
    while (first > 0 && entryOfDay(rows[first - 1]) === entry) first--;
    while (last < rows.length - 1 && entryOfDay(rows[last + 1]) === entry) last++;
  }
  return (
    <Rectangle {...rest} x={x - (payloadIndex - first) * width} width={width * (last - first + 1)} />
  );
}
