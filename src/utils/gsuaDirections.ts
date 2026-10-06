// The GSUA direction picker's shared rules, for the daily and monthly pages.
//
// The picker offers AXES — the directions the stacked coverage chart draws —
// not raw report lines: a direction the GS folded into another
// (DIRECTION_AXIS, e.g. N-Slobozhanshchyna into Kursk) is that axis. And a
// picked direction's figure is the coverage chart's own: from the day's
// canonical report, a jointly reported line split fairly between its members.
// So a direction reads the same picked on its own as it does in the stack.
import { qualitativeColor } from "@/chartColors";
import type { MultiSelectOption } from "@/components/CheckboxMultiSelect";
import {
  DIRECTION_AXIS_JOINT_LABEL, directionAxis, type DailyDataPoint, type GsuaDirectionCoverageRow,
} from "@/types";

// The axes in `list` (directions ranked by all-time attacks), in that order.
export function axesOf(list: string[]): string[] {
  return [...new Set(list.map(directionAxis))];
}

// `direction=` holds a comma list of axes. A link from before several could be
// picked holds one name, which parses the same; one naming a folded direction
// opens its axis. No direction name contains a comma.
export function parseDirectionsParam(raw: string | null): string[] {
  return [...new Set((raw ?? "").split(",").filter(Boolean).map(directionAxis))];
}

export const axisLabel = (axis: string): string => DIRECTION_AXIS_JOINT_LABEL[axis] ?? axis;

// A direction keeps its colour whatever else is picked, and on both pages:
// its place among the axes by attacks, not in the selection.
export function directionColor(list: string[], axis: string, selected: string[]): string {
  const axes = axesOf(list);
  const i = axes.indexOf(axis);
  return qualitativeColor(i >= 0 ? i : axes.length + selected.indexOf(axis));
}

// The picker's options: alphabetical, to be found by name, each with the
// colour its series is drawn in.
export function directionOptions(list: string[]): MultiSelectOption[] {
  return axesOf(list)
    .map((axis) => ({ value: axis, label: axisLabel(axis), color: directionColor(list, axis, []) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// The page title's direction part: up to three by name.
export function directionsTitle(dirs: string[]): string {
  return dirs.length <= 3 ? dirs.map(axisLabel).join(", ") : `${dirs.length} directions`;
}

// One axis's attacks per period, read off the coverage rows. A period whose
// report doesn't name the direction is 0 for it — the report lists where there
// was fighting, and the stack reads it the same way; only a period with no
// report at all is a gap.
// Rounded to a tenth: a fair share is fractional (half a joint line, and
// thirds summed over a month), and the charts would otherwise print 296.667.
export function axisSeries(
  rows: GsuaDirectionCoverageRow[],
  axis: string,
  note?: (row: GsuaDirectionCoverageRow) => string | undefined,
): DailyDataPoint[] {
  return rows.map((r) => ({
    date: r.date,
    value: r.total == null && !Object.keys(r.byDirection).length ? null : Math.round((r.byDirection[axis] ?? 0) * 10) / 10,
    is_today: r.is_today,
    note: note?.(r),
  }));
}
