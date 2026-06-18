import type { ModelBreakdownEntry } from "@/types";
import type { Theme } from "@/theme";

// Full per-model breakdown rendered inside chart tooltips. Shared between the
// daily and monthly RU air-attacks category charts so the layout (and the
// 📈/🎯 column glyphs) stays identical between the two views. Lists every
// model present in the hovered bucket — at our category sizes the tail is
// short enough (≤~12 rows) that a hard cap isn't worth it.
function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

export function ModelBreakdownTable({
  entries,
  t,
}: {
  entries: ModelBreakdownEntry[];
  t: Theme;
}) {
  const numCell = {
    textAlign: "right" as const,
    padding: "0 0 0 10px",
    whiteSpace: "nowrap" as const,
  };
  const pctOf = (launched: number, intercepted: number) =>
    launched > 0 ? `${((intercepted / launched) * 100).toFixed(0)}%` : "—";
  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 6,
        borderTop: `1px solid ${t.border}`,
        color: t.textMuted,
      }}
    >
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Model</th>
            <th title="Number launched" style={numCell}>📈</th>
            <th title="Interception Rate" style={numCell}>🎯</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.model}>
              <td style={{ color: t.text, padding: 0 }}>{e.model}</td>
              <td style={numCell}>{fmt(e.launched)}</td>
              <td style={numCell}>{pctOf(e.launched, e.intercepted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
