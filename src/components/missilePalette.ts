// Shared categorical palette for the multi-type missile charts (combined line +
// stacked bar), so a given missile type keeps one colour across both views.
export const MISSILE_PALETTE = [
  "#1d6fa4", "#db2c18", "#70a65b", "#b07bd1", "#e08a1e", "#2bb3a3",
  "#c2477f", "#7a8cff", "#9c8b3e", "#4aa3df", "#d05b5b", "#5cae8b",
  "#8e6fc4", "#cf9b3a", "#3fb0c9", "#b85c9e",
];

export function colorMap(keys: string[]): Map<string, string> {
  const m = new Map<string, string>();
  keys.forEach((k, i) => m.set(k, MISSILE_PALETTE[i % MISSILE_PALETTE.length]));
  return m;
}
