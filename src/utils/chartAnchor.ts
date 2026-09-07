// Stable-ish URL fragment for a chart card, derived from its title, so a chart
// can be linked directly: `?site=rubikon&page=monthly#mortars`.
//
// Title-derived rather than keyed off each dataset's category enum: one rule
// that every chart page gets for free, with no per-page anchor table to keep
// in sync. The trade-off is that renaming a chart's label breaks existing
// links to it — acceptable for a dashboard, and the page still loads, it just
// doesn't scroll.
//
// Returns "" for a title with no Latin/digit characters at all; callers omit
// the id in that case rather than emitting an empty one.
export function chartAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[«»"'’]/g, "")        // drop quote marks rather than turn them into separators
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
