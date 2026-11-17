import { useTheme } from "@/hooks/useTheme";
import { ColumnGrid, LINE_H, type GridHeight } from "@/components/ColumnGrid";
import type { RegionList } from "@/utils/ruModRegions";

// Six rows a column, far shorter than the hourly chart's date grid: a day
// names up to ~25 regions, and the windows chart stacks two lists under its
// table, so the list goes wide before it makes the card taller than a screen.
const GRID_HEIGHT: GridHeight = { css: "min(14vh, 110px)", px: (vh) => Math.min(vh * 0.14, 110) };

/** The regions an RU MoD day (or one of its windows, `label`) named, below a
 *  daily chart's tooltip table: name and count in rows, as many columns as
 *  the height allows. */
export function RuModRegionList({ list, label }: { list: RegionList; label?: string }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>
        {label ? `${label} · ${list.heading}` : list.heading}
      </div>
      <ColumnGrid maxHeight={GRID_HEIGHT}>
        {list.items.map((it) => (
          <div key={it.name} style={{
            display: "flex", gap: 8, justifyContent: "space-between",
            color: t.textMuted, lineHeight: `${LINE_H}px`, whiteSpace: "nowrap",
          }}>
            <span>{it.name}</span>
            {it.value != null && <span style={{ color: t.text }}>{it.value}</span>}
          </div>
        ))}
      </ColumnGrid>
    </div>
  );
}
