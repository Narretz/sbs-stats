// Shared time-window options for every daily & hourly chart view. Single source
// so the picker is identical everywhere. 150d/180d are less meaningful for the
// hourly views (lots of overlaid days), but we keep one list for consistency.
export const DAY_OPTIONS = [7, 14, 30, 60, 90, 120, 150, 180] as const;
export type DayOption = (typeof DAY_OPTIONS)[number];
