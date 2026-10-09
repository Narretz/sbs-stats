import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { LazyChartArea } from "@/components/LazyChartArea";

// Plot areas render when they come within a viewport of the screen, and hold
// their exact height until then. Thirty of them in a column, each standing in
// for a chart. On a real page — the SBS hourly page's 89 charts, and a chart
// that arrived by scrolling being fully interactive — it's
// e2e/chart-lazy-render.spec.ts.
const N = 30, H = 220;

let win: Window = window;
async function mount() {
  const r = await render(
    <div>
      {Array.from({ length: N }, (_, i) => (
        <div key={i} style={{ marginBottom: 20 }}>
          <LazyChartArea height={H}><div data-rendered style={{ height: H }}>chart {i}</div></LazyChartArea>
        </div>
      ))}
    </div>,
  );
  win = r.container.ownerDocument.defaultView!;
}

const count = () => ({
  rendered: win.document.querySelectorAll("[data-rendered]").length,
  pending: win.document.querySelectorAll("[data-chart-pending]").length,
  height: win.document.documentElement.scrollHeight,
});
// `instant`: a smooth scroll read mid-animation measures the animation.
const scrollTo = (top: number) => win.scrollTo({ top, behavior: "instant" as ScrollBehavior });

describe("LazyChartArea", () => {
  it("renders only what is near the viewport; the rest hold their space", async () => {
    await mount();
    await expect.poll(() => count().rendered).toBeGreaterThan(0);
    const c = count();
    expect(c.rendered).toBeLessThan(N / 2);
    expect(c.rendered + c.pending).toBe(N);
  });

  it("keeps the page its full height as charts arrive", async () => {
    await mount();
    await expect.poll(() => count().rendered).toBeGreaterThan(0);
    const { height: before, rendered } = count();
    scrollTo(before);
    await expect.poll(() => count().rendered).toBeGreaterThan(rendered);
    // The placeholder is the plot's exact height: nothing lengthens or shifts.
    expect(count().height).toBe(before);
  });

  it("renders more on scrolling, and never takes one back", async () => {
    await mount();
    await expect.poll(() => count().rendered).toBeGreaterThan(0);
    const start = count().rendered;
    scrollTo(count().height);
    await expect.poll(() => count().rendered).toBeGreaterThan(start);
    const bottom = count().rendered;
    // Unmounting on the way back would pay the expensive first render again.
    scrollTo(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(count().rendered).toBe(bottom);
  });
});
