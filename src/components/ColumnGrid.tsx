import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
const COL_GAP = 12;
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

// How many rows a column takes, from the two bounds: the height the grid gets,
// and the width — in the pinned sheet a short body would otherwise spread the
// grid past its content column, off-centre into the right-hand gutter. `cw` is
// the width `width` was worked out for.
interface Fit { height: number; width: number; cw: number }

export function ColumnGrid({ children, maxHeight, testId }: {
  children: ReactNode[];
  maxHeight: GridHeight;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit>(() =>
    ({ height: rowsIn(maxHeight.px(window.innerHeight)), width: 0, cw: 0 }));
  const perColumn = Math.max(fit.height, fit.width);
  // Width-bound: more rows than the height allows, so the grid is as tall as
  // its rows and the sheet scrolls, rather than its rows spilling over what
  // follows.
  const widthBound = fit.width > fit.height;
  const count = useRef(children.length);
  count.current = children.length;

  const measure = useCallback(() => {
    const el = ref.current;
    const cols = el?.children.length ?? 0;
    if (!el || !cols) return;
    setFit((prev) => {
      // A width-bound grid's height is its content's, which says nothing
      // about the height it was given: keep the last one measured.
      const height = prev.width > prev.height || el.clientHeight <= 0 ? prev.height : rowsIn(el.clientHeight);
      const cw = el.clientWidth;
      const overflows = el.scrollWidth > cw + 1;
      // Rows for the columns that fit, at the columns' average width. In the
      // floating card the grid is as wide as its columns and never overflows.
      const avg = (el.scrollWidth + COL_GAP) / cols;
      const need = Math.ceil(count.current / Math.max(1, Math.floor((cw + COL_GAP) / avg)));
      // For a given width only ever more rows, by at least one, so it settles
      // instead of swapping between two layouts; a new width starts over.
      const width = cw !== prev.cw
        ? (overflows ? need : 0)
        : overflows ? Math.max(need, Math.max(prev.height, prev.width) + 1) : prev.width;
      return height === prev.height && width === prev.width && cw === prev.cw ? prev : { height, width, cw };
    });
  }, []);

  // Observed rather than measured once: the height this grid is given changes
  // under it — the window resizes, the sheet opens, a phone rotates.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // And again after every re-chunk, which changes the width but not always
  // the box the observer watches.
  useLayoutEffect(measure, [measure, perColumn, children.length]);

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
        gap: COL_GAP,
        alignItems: "flex-start",
        // Claims the sheet body's leftover height; inert in the card, where the
        // parent is an ordinary block and the cap is the only bound.
        flex: "1 1 auto",
        minHeight: widthBound ? "auto" : 0,
        maxHeight: widthBound ? "none" : maxHeight.css,
      }}
    >
      {columns.map((col, ci) => (
        <div key={ci} style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>{col}</div>
      ))}
    </div>
  );
}
