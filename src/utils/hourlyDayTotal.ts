// A day's figure on the hourly page: its LAST reading the chart shows (up to
// 23:00), as collected. Not its highest — SBS revises a running total down as
// well as up — and not the settled figure the daily page uses, which includes
// next-morning revisions the hourly lines never show. Both stat scopes (the
// window and ALL) read days this way, so the two agree with each other and
// with what hovering the day's last point says.
export function lastReading(points: readonly { hour: number; value: number | null | undefined }[]): number | null {
  let hour = -1;
  let value: number | null = null;
  for (const p of points) {
    if (typeof p.value === "number" && p.hour > hour) {
      hour = p.hour;
      value = p.value;
    }
  }
  return value;
}

// Every day's last reading of `key`, from rows of (date, hour, …values) — the
// whole-dataset counterpart of the window's per-series lastReading.
export function lastReadingsByDay<K extends string>(
  rows: readonly ({ date: string; hour: number } & Partial<Record<K, number | null>>)[],
  key: K,
): (number | null)[] {
  const byDay = new Map<string, { hour: number; value: number | null | undefined }[]>();
  for (const r of rows) {
    let list = byDay.get(r.date);
    if (!list) byDay.set(r.date, (list = []));
    list.push({ hour: r.hour, value: r[key] });
  }
  return [...byDay.values()].map(lastReading);
}
