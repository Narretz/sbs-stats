import { useEffect, useRef } from "react";

// Scroll to the chart named by the URL fragment once it exists.
//
// The browser's own fragment handling is useless here: at load time the target
// doesn't exist yet — the DB is still being fetched and no chart has rendered.
// So we wait for the page to report `ready` and then poll briefly for the id.
//
// Two scrolls, not one: recharts' ResponsiveContainer measures itself after
// mount, so cards above the target grow a moment later and the first scroll
// lands short. The second pass, after layout settles, corrects it.
const POLL_MS = 50;
const POLL_ATTEMPTS = 40;   // ≈2s — covers a slow first paint, then gives up
const SETTLE_MS = 400;      // after charts have sized themselves

export function useChartHashScroll(ready: boolean) {
  // Only ever fires once per mount: re-scrolling on a later re-render would
  // yank the page back while the reader is scrolling around.
  const handled = useRef(false);

  useEffect(() => {
    if (!ready || handled.current) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) {
      handled.current = true;
      return;
    }

    const timers: number[] = [];
    let attempts = 0;

    // `behavior: "auto"` overrides the global `scroll-behavior: smooth`:
    // animating a jump the reader didn't ask for, from the top of a long page,
    // is slow and disorienting. In-page clicks on the "#" affordance still
    // glide, because those go through CSS.
    const jump = () =>
      document.getElementById(id)?.scrollIntoView({ behavior: "auto", block: "start" });

    const tick = () => {
      if (document.getElementById(id)) {
        handled.current = true;
        jump();
        timers.push(window.setTimeout(jump, SETTLE_MS));
        return;
      }
      if (++attempts >= POLL_ATTEMPTS) {
        handled.current = true;   // no such chart on this page — leave the page alone
        return;
      }
      timers.push(window.setTimeout(tick, POLL_MS));
    };
    tick();

    return () => timers.forEach(window.clearTimeout);
  }, [ready]);
}
