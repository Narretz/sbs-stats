import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

// A chart's plot area, rendered when it is nearly in view.
//
// The grid pages hold a lot of charts — SBS hourly mounts 89 (7 headline
// metrics + 46 target classes x hit/destroyed), each with one <Line> per day in
// the window — and recharts is not cheap. At a 120-day window that is ~10,000
// series nodes, 5.6 seconds of blocked main thread before the page answers a
// click, almost all of it spent on charts nobody has scrolled to yet.
//
// So the plot area waits until it is within one viewport of the screen, and an
// empty box of its exact height holds the space meanwhile: the page is its full
// height from the first frame, so the scrollbar doesn't lurch and a deep link
// still lands where it should (see useChartHashScroll, which scrolls to a card
// that may not have drawn its chart yet — it will, at the same height).
//
// Once rendered it stays. Unmounting on the way out would pay the render again
// on the way back, and the first render is the expensive one; a chart already
// drawn costs only the memory to keep.
const MARGIN = "100%"; // one viewport above and below — three viewports in all

/**
 * Has `ref`'s element come within a viewport of the screen? Latches: once true
 * it never goes back, for the reason above.
 *
 * Charts whose data preparation is itself expensive take this directly and skip
 * that work too — the hourly overlay pivots one row per hour against every day
 * in the window, ~200ms across the page at 120 days, and re-does it on each
 * hover. Everything else wants the component below.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the hook and the box it renders are one mechanism, kept together like usePinnedChart
export function useNearViewport(ref: RefObject<Element>): boolean {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    // Without IntersectionObserver, render everything as before: a slow page
    // beats a page whose charts never arrive.
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: `${MARGIN} 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);

  return near;
}

export function LazyChartArea({ height, children }: { height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  if (near) return <>{children}</>;
  return <ChartPlaceholder inner={ref} height={height} />;
}

/** The box that holds a chart's space until it renders. Exactly the plot
 *  area's height, so nothing below it moves when the chart arrives. */
export function ChartPlaceholder(
  { inner, height }: { inner: RefObject<HTMLDivElement>; height: number },
) {
  return <div ref={inner} style={{ height }} data-chart-pending="" />;
}
