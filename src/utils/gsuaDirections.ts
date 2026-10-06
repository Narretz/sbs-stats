// The GSUA direction picker's shared rules, for the daily and monthly pages.
import { qualitativeColor } from "@/chartColors";
import type { MultiSelectOption } from "@/components/CheckboxMultiSelect";

// `direction=` holds a comma list. A link from before several directions could
// be picked holds one name, which parses the same; no direction name contains
// a comma.
export function parseDirectionsParam(raw: string | null): string[] {
  return (raw ?? "").split(",").filter(Boolean);
}

// A direction keeps its colour whatever else is picked, and on both pages:
// its place in the full list (`list`, by attacks), not in the selection.
export function directionColor(list: string[], dir: string, selected: string[]): string {
  const i = list.indexOf(dir);
  return qualitativeColor(i >= 0 ? i : list.length + selected.indexOf(dir));
}

// The picker's options: alphabetical, to be found by name, each with the
// colour its series is drawn in.
export function directionOptions(list: string[]): MultiSelectOption[] {
  return [...list]
    .sort((a, b) => a.localeCompare(b))
    .map((d) => ({ value: d, label: d, color: directionColor(list, d, []) }));
}

// The page title's direction part: up to three by name.
export function directionsTitle(dirs: string[]): string {
  return dirs.length <= 3 ? dirs.join(", ") : `${dirs.length} directions`;
}
