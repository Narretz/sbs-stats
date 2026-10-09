import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@/styles/theme.css";
import { ChartPinProvider } from "@/hooks/ChartPinProvider";
import { RouteProvider } from "@/hooks/RouteContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { ChartSheet } from "@/components/ChartSheet";
import { DailyLineChart } from "@/components/DailyLineChart";
import type { DailyDataPoint } from "@/types";

// The pinned-detail sheet with real charts above it, minus the page: click or
// tap a chart to pin one x-position, step it with ‹ › or the arrow keys, close
// it, pin another chart. Two daily charts on fixed rows, the singleton sheet
// and the real stylesheet — the sheet's focus depends on its CSS transition.
//
// Two of these carry most of the weight. "prev/next moves both" proves the
// selection is genuinely ours rather than recharts' hover state, and "new data
// keeps or drops the pin" proves it is keyed by date rather than by index — an
// index-keyed pin would silently slide onto a different day when the data
// underneath is replaced. On real pages, per chart family, it's
// e2e/chart-pin-families.spec.ts.

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
const rows = (from: number, to: number, value = (n: number) => n * 10): DailyDataPoint[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
    .map((n) => ({ date: day(n), value: value(n), is_today: false }));
const label = (iso: string) => iso.split("-").reverse().join(".");

const FIRST = "First chart", SECOND = "Second chart";

function Shell({ children }: { children: ReactNode }) {
  const route = useAppRoute();
  return (
    <RouteProvider value={route}>
      <ChartPinProvider>
        <h1>Page</h1>
        <div style={{ width: 900 }}>{children}</div>
        <ChartSheet />
      </ChartPinProvider>
    </RouteProvider>
  );
}

const chart = (title: string, data: DailyDataPoint[]) => (
  <DailyLineChart title={title} data={data} globalMax={0} globalMedian={0} wfull />
);

// The first chart's data can be swapped from outside, as a page does when its
// window changes.
let setFirst: (d: DailyDataPoint[]) => void = () => {};
function Charts({ first = rows(1, 7) }: { first?: DailyDataPoint[] }) {
  const [data, setData] = useState(first);
  setFirst = setData;
  return <Shell>{chart(FIRST, data)}{chart(SECOND, rows(1, 7, (n) => 100 - n))}</Shell>;
}

// The document the charts render into — not necessarily the test's global
// `document`, so every lookup goes through the rendered container.
let doc: Document = document;
async function mount(ui: ReactNode) {
  const r = await render(ui);
  doc = r.container.ownerDocument;
}

const card = (title: string) => doc.querySelector<HTMLElement>(`.chart-card#${title.toLowerCase().replace(/ /g, "-")}`)!;
const sheet = () => page.getByRole("region");
const sheetLabel = () => doc.querySelector(".chart-sheet-label")?.textContent ?? null;
const isOpen = () => doc.querySelector(".chart-sheet[data-open]") != null;

// Click a chart's plot at a fraction across its width. The height is
// arbitrary: recharts resolves a click to the nearest x-band, so the whole plot
// is a hit target — which is the entire point on touch.
async function pinAt(title: string, frac: number) {
  const svg = await waitForSvg(title);
  const box = svg.getBoundingClientRect();
  await userEvent.click(svg, { position: { x: box.width * frac, y: box.height * 0.4 } });
  await expect.poll(isOpen).toBe(true);
}

async function waitForSvg(title: string): Promise<SVGElement> {
  let svg: SVGElement | null = null;
  await expect.poll(() => (svg = card(title)?.querySelector("svg.recharts-surface") ?? null)).not.toBeNull();
  return svg!;
}

// x of the pinned cursor: the one vertical reference line (MED is horizontal).
function cursorX(title: string): number | null {
  for (const el of card(title).querySelectorAll(".recharts-reference-line line")) {
    const x1 = Number(el.getAttribute("x1")), x2 = Number(el.getAttribute("x2"));
    const y1 = Number(el.getAttribute("y1")), y2 = Number(el.getAttribute("y2"));
    if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 1) return x1;
  }
  return null;
}

// recharts activates a tooltip from mousemove; sweep a few pixels so one lands
// after it has bound its handlers.
async function hover(title: string) {
  const svg = await waitForSvg(title);
  const box = svg.getBoundingClientRect();
  for (const dx of [-6, -3, 0, 3]) {
    await userEvent.hover(svg, { position: { x: box.width * 0.5 + dx, y: box.height * 0.4 } });
  }
}
const tooltipText = (title: string) =>
  (card(title).querySelector<HTMLElement>(".recharts-tooltip-wrapper")?.innerText ?? "").trim();

describe("Chart pin sheet", () => {
  it("clicking a point opens the sheet with that date's values", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.95);
    await expect.element(sheet()).toMatchTextContent(FIRST);
    expect(sheetLabel()).toBe(label(day(7)));
    await expect.element(sheet()).toMatchTextContent("70");
  });

  it("prev/next moves the sheet date and the chart cursor together", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.5);
    const start = sheetLabel(), startX = cursorX(FIRST);
    expect(startX).not.toBeNull();

    await page.getByLabelText("Next point").click();
    expect(sheetLabel()).not.toBe(start);
    // Both views of one piece of state: the cursor travels right, in step.
    expect(cursorX(FIRST)!).toBeGreaterThan(startX!);

    await page.getByLabelText("Previous point").click();
    expect(sheetLabel()).toBe(start);
    expect(cursorX(FIRST)).toBeCloseTo(startX!, 0);
  });

  it("the arrow keys step the pin, because focus lands in the sheet", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.5);
    // Guards the keyboard path: the sheet only gets these keys because focus
    // moved into it on open, which a CSS `visibility` transition can prevent.
    await expect.poll(() => doc.activeElement?.classList.contains("chart-sheet")).toBe(true);
    const start = sheetLabel();
    await userEvent.keyboard("{ArrowRight}");
    expect(sheetLabel()).not.toBe(start);
    await userEvent.keyboard("{ArrowLeft}");
    expect(sheetLabel()).toBe(start);
  });

  it("the stepper is disabled at both ends — it never wraps", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.08);
    expect(sheetLabel()).toBe(label(day(1)));
    await expect.element(page.getByLabelText("Previous point")).toBeDisabled();
    await expect.element(page.getByLabelText("Next point")).toBeEnabled();

    await pinAt(FIRST, 0.95);
    expect(sheetLabel()).toBe(label(day(7)));
    await expect.element(page.getByLabelText("Next point")).toBeDisabled();
    await expect.element(page.getByLabelText("Previous point")).toBeEnabled();
  });

  it("a date with no data says so instead of rendering an empty sheet", async () => {
    // recharts drops null points from its payload, so this used to render nothing.
    await mount(<Charts first={[...rows(1, 3, () => null as unknown as number), ...rows(4, 7)]} />);
    await pinAt(FIRST, 0.08);
    await expect.element(sheet()).toMatchTextContent("No data reported for this date.");
  });

  it("close: ✕, Escape and an outside click each dismiss; a second point re-selects", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.95);
    await page.getByLabelText("Close details").click();
    await expect.poll(isOpen).toBe(false);

    await pinAt(FIRST, 0.95);
    await userEvent.keyboard("{Escape}");
    await expect.poll(isOpen).toBe(false);

    await pinAt(FIRST, 0.95);
    await page.getByRole("heading", { name: "Page" }).click();
    await expect.poll(isOpen).toBe(false);

    // Clicking elsewhere in the same chart re-selects rather than dismisses.
    await pinAt(FIRST, 0.95);
    const before = sheetLabel();
    await pinAt(FIRST, 0.3);
    expect(isOpen()).toBe(true);
    expect(sheetLabel()).not.toBe(before);
  });

  it("pinning a second chart releases the first", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.95);
    expect(cursorX(FIRST)).not.toBeNull();
    await pinAt(SECOND, 0.5);
    await expect.element(sheet()).toMatchTextContent(SECOND);
    // Only one pin exists at a time.
    expect(cursorX(FIRST)).toBeNull();
  });

  it("the pinned chart's hover tooltip goes quiet; other charts keep theirs", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.95);
    await hover(FIRST);
    // innerText: a tooltip recharts has hidden must read as empty.
    expect(tooltipText(FIRST)).toBe("");
    card(SECOND).scrollIntoView({ block: "start" });
    await hover(SECOND);
    await expect.poll(() => tooltipText(SECOND)).not.toBe("");
  });

  it("new data keeps a pin whose date is still there, and drops one whose date isn't", async () => {
    await mount(<Charts />);
    await pinAt(FIRST, 0.95);
    // A wider window: the date moves to a new index and the pin follows it.
    setFirst(rows(1, 14).map((r) => ({ ...r, date: `2026-09-${r.date.slice(8)}` })).concat(rows(1, 7)));
    await expect.poll(sheetLabel).toBe(label(day(7)));
    expect(isOpen()).toBe(true);

    // A narrower one that excludes it: the pin goes.
    setFirst(rows(1, 3));
    await expect.poll(isOpen).toBe(false);
  });
});
