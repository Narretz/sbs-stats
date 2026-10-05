// The General Staff's figures for a day are cumulative and settle with the
// wrap-up report it posts the NEXT morning (08:00). Until that lands, a day's
// latest report is one dated the same day — 22:00, and up to 3 Aug 2026 also
// an afternoon one, usually 16:00 — and its figures are an interim reading that will still move.
//
// `snapshotAt` is the "станом на" time of the report a day's figure came from
// (YYYY-MM-DDTHH:MM…), in Kyiv time.

// The interim report's time ("22:00"), or null when the day is settled — or
// when there is no snapshot to tell, as for a monthly bucket.
export function interimReportTime(date: string, snapshotAt: string | null | undefined): string | null {
  if (!snapshotAt || snapshotAt.slice(0, 10) !== date) return null;
  return snapshotAt.slice(11, 16);
}

export function interimNote(date: string, snapshotAt: string | null | undefined): string | undefined {
  const time = interimReportTime(date, snapshotAt);
  return time
    ? `Interim ${time} report — the day's wrap-up report (posted the next morning at 08:00) isn't in yet, so this figure will likely still grow.`
    : undefined;
}
