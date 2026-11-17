import { useTheme } from "@/hooks/useTheme";
import { ColumnGrid, LINE_H, type GridHeight } from "@/components/ColumnGrid";
import type { RegionList } from "@/utils/ruModRegions";

// A day's list: six rows a column, far shorter than the hourly chart's date
// grid. A day names up to ~25 regions, and the windows chart stacks two lists
// under its table, so it goes wide before it makes the card taller than a
// screen. A month names up to ~50 in one list, which at six rows would run
// off the side of the screen instead, so it gets the hourly grid's height.
const GRID_HEIGHT: GridHeight = { css: "min(14vh, 110px)", px: (vh) => Math.min(vh * 0.14, 110) };
const TALL_GRID_HEIGHT: GridHeight = { css: "min(34vh, 300px)", px: (vh) => Math.min(vh * 0.34, 300) };

/** The regions an RU MoD day or month (or one of its windows, `label`)
 *  named, below a chart's tooltip table: name, count and — on the monthly
 *  page — days named, in rows, as many columns as the height allows. */
export function RuModRegionList({ list, label, tall = false }: { list: RegionList; label?: string; tall?: boolean }) {
  const { theme: t } = useTheme();
  return (
    // No wrapper: in the pinned sheet the grid has to be an item of the
    // sheet body's own flex column, so it can take the height left over (and
    // grow back to its rows when the width binds) — a box around it would
    // need min-height: 0 to let it shrink, and would then let it spill out
    // over whatever follows. The heading keeps its line.
    <>
      <div style={{ color: t.textMuted, marginTop: 8, marginBottom: 4, flex: "none" }}>
        {label ? `${label} · ${list.heading}` : list.heading}
      </div>
      <ColumnGrid maxHeight={tall ? TALL_GRID_HEIGHT : GRID_HEIGHT}>
        {list.items.map((it) => (
          <div key={it.name} style={{
            display: "flex", gap: 8, justifyContent: "space-between",
            color: t.textMuted, lineHeight: `${LINE_H}px`, whiteSpace: "nowrap",
          }}>
            <span>{it.name}</span>
            <span>
              {it.value != null && <span style={{ color: t.text }}>{it.value}</span>}
              {it.days && <span style={{ display: "inline-block", minWidth: "4ch", textAlign: "right", marginLeft: 6 }}>{it.days}</span>}
            </span>
          </div>
        ))}
      </ColumnGrid>
    </>
  );
}
