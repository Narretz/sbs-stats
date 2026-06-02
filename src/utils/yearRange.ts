// Shared time-window options for monthly chart views. The list grows as the war
// drags on: we start at 1y and add another year once enough time has passed
// that the next bucket would actually show new data. War start is 2022-02-24
// (full-scale invasion); pre-invasion dates aren't in any of our datasets.
export const WAR_START_DATE = "2022-02-24";

export type YearOption = number;

// Whole years elapsed since the war start, rounded up. Used both to build the
// dropdown options ([1..ceil]) and as the "all" sentinel — picking the top
// option is equivalent to "since 2022-02-24".
export function yearsSinceWarStart(today: Date = new Date()): number {
  const start = new Date(`${WAR_START_DATE}T00:00:00Z`);
  const ms = today.getTime() - start.getTime();
  const years = ms / (365.25 * 24 * 60 * 60 * 1000);
  return Math.max(1, Math.ceil(years));
}

export function getYearOptions(today: Date = new Date()): YearOption[] {
  const max = yearsSinceWarStart(today);
  return Array.from({ length: max }, (_, i) => i + 1);
}

export const DEFAULT_YEAR_OPTION: YearOption = 1;
