import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Rows in as many columns as the available height allows: the hourly chart's
// tooltip (one row per day of the window) and the RU MoD tooltips' region list.
//
// The columns are real sibling elements, chunked here, rather than a
// column-direction `flex-wrap`. The wrap reads better and needs no arithmetic,
// but a wrapping flex box reports its max-content width as a SINGLE column in
// Firefox (Chrome sums the lines), and the card is sized by exactly that
// measurement — so the card came out as wide as its header line, about three
// columns, and every column past the third hung outside its border. As a row
// of siblings the width is the sum by construction, in every engine.
//
// How many rows per column is a question about height, and neither renderer
// answers it on its own: the sheet hands the grid a definite height (it is a
// flex child of `.chart-sheet-body`) but more of it than the grid should take,
// while a floating tooltip is positioned rather than laid out and bounds
// nothing at all. So `maxHeight` bounds both, and the grid re-chunks to
// the height it actually got — which converges in one layout pass, and follows
// a window resize or a rotation.
export const LINE_H = 15;
const ROW_GAP = 4;
// Rows that fit in `h` pixels: n lines plus the gaps BETWEEN them, so the
// inverse is (h + gap) / (line + gap) — not h / row, which reads one row short
// of what it just laid out and walks the column count down a row per pass.
const rowsIn = (h: number) => Math.max(1, Math.floor((h + ROW_GAP) / (LINE_H + ROW_GAP)));

export interface GridHeight {
  /** Past this the grid starts a new column; CSS, so it follows the window. */
  css: string;
  /** The same bound in pixels for a viewport `vh` pixels tall: the first
   *  layout's guess, before the grid has been measured. */
  px: (vh: number) => number;
}

export function ColumnGrid({ children, maxHeight, testId }: {
  children: ReactNode[];
  maxHeight: GridHeight;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [perColumn, setPerColumn] = useState(() =>
    rowsIn(maxHeight.px(window.innerHeight)));

  // Observed rather than measured once: the height this grid is given changes
  // under it — the window resizes, the sheet opens, a phone rotates.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setPerColumn((prev) => (prev === rowsIn(h) ? prev : rowsIn(h)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns: ReactNode[][] = [];
  for (let i = 0; i < children.length; i += perColumn) {
    columns.push(children.slice(i, i + perColumn));
  }
  return (
    <div
      ref={ref}
      data-testid={testId}
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        // Claims the sheet body's leftover height; inert in the card, where the
        // parent is an ordinary block and the cap is the only bound.
        flex: "1 1 auto",
        minHeight: 0,
        maxHeight: maxHeight.css,
      }}
    >
      {columns.map((col, ci) => (
        <div key={ci} style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>{col}</div>
      ))}
    </div>
  );
}
