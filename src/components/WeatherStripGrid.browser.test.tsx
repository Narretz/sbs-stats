import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@/styles/theme.css";
import { ChartPinProvider } from "@/hooks/ChartPinProvider";
import { RouteProvider } from "@/hooks/RouteContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { ChartSheet } from "@/components/ChartSheet";
import { StripGrid, type GridProps } from "@/components/WeatherStripGrid";
import { FCST_AXIS } from "@/components/weatherStripShared";
import type { TooltipDescriptor } from "@/components/TooltipTable";
import { dateAxisLabels } from "@/utils/weatherStrip";
import { OK, SEVERE } from "@/utils/weatherRating";

// The weather strips' grid on its own: synthetic columns, rows and
// descriptors, no DB and no page. What the grid does with them — the hover
// card and the pinned sheet, and how it fits a window of days into the width
// it gets (gaps, labels, the Σ numbers) — is all here; that real weather rows
// reach it, on which pages, is e2e/weather-strip.spec.ts.

const VIEWPORT = { width: 1000, height: 700 };   // vitest.config.ts's
afterEach(() => page.viewport(VIEWPORT.width, VIEWPORT.height));

function Shell({ children, width }: { children: ReactNode; width: number }) {
  const route = useAppRoute();
  return (
    <RouteProvider value={route}>
      <ChartPinProvider>
        <div style={{ width }}>{children}</div>
        <ChartSheet />
      </ChartPinProvider>
    </RouteProvider>
  );
}

// Shaped like the strips' real ones (utils/weatherDescriptors): a cell's card
// is a list of readings, a column's sheet a table of every direction.
const cellCard = (header: string): TooltipDescriptor => ({
  header,
  rows: [
    { label: "Drones", value: "severe", color: "#000" },
    { label: "Severe / limited", value: "9 h / 3 h", color: "#000" },
    { label: "Mainly", value: "fog, low cloud, gusts", color: "#000" },
    { label: "Drone-denied", value: "01:00–09:00", color: "#000" },
    { label: "Min visibility", value: "0.1 km", color: "#000" },
  ],
  minWidth: 260,
});
const columnSheet = (header: string): TooltipDescriptor => ({
  header,
  valueLabel: "Drones",
  extraColumns: ["Severe h", "Mainly", "Drone-denied", "mm", "Gust m/s", "Vis km"],
  rows: [{ label: "Bravo", color: "#000", value: "severe", extra: [9, "fog, low cloud", "01–09", "0.4", "12", "0.1"] }],
});

/** `days` window columns, then a forecast one if asked: the daily strip's
 *  shape, labelled as it labels them. Two directions; Σ is 10 everywhere, two
 *  digits to fit. */
function props({ days, forecast = false, progress }: { days: number; forecast?: boolean; progress?: number }): GridProps {
  const labels = dateAxisLabels(days);
  const columns = [
    ...Array.from({ length: days }, (_, i) => ({ key: i, axis: labels[i] ? `d${i}` : "", thinAxis: labels[i] === "thin" })),
    ...(forecast ? [{ key: "fc", axis: FCST_AXIS, forecast: true }] : []),
  ];
  const n = columns.length;
  return {
    id: "weather-grid-test",
    title: "Weather grid",
    subtitle: "subtitle",
    columns,
    progress: progress != null ? { columns: progress, title: "progress" } : undefined,
    rows: ["Alpha", "Bravo"].map((label, r) => ({
      key: label, label, title: label,
      cells: Array.from({ length: n }, (_, i) => ({ level: (i + r) % 3 ? OK : SEVERE, faded: i >= days })),
      tail: "1", tailSuffix: `/${days}`, tailStrong: true,
    })),
    count: { label: "Σ severe", title: "count", values: Array(n).fill(10) },
    tailHeader: "SEVERE",
    legend: [],
    cellDescriptor: (r, i) => cellCard(`${r === 0 ? "Alpha" : "Bravo"} · cell ${i}`),
    columnDescriptor: (i) => columnSheet(`column ${i} · every direction`),
    columnLabel: (i) => `Column ${i}`,
  };
}

let doc: Document = document;
// A test that mounts twice measures the second: render() keeps the first.
// Between tests vitest-browser-react cleans up itself.
let unmount: (() => Promise<void>) | null = null;
afterEach(() => { unmount = null; });
async function mount(p: GridProps, width = 900) {
  await unmount?.();
  const r = await render(<Shell width={width}><StripGrid {...p} /></Shell>);
  doc = r.container.ownerDocument;
  unmount = r.unmount;
}

const grid = () => doc.querySelector<HTMLElement>("[role=grid]")!;
const cell = (col: number, row = 0) =>
  doc.querySelector<HTMLElement>(`[role=gridcell][data-row="${row}"][data-col="${col}"]`)!;
const rect = (el: Element) => el.getBoundingClientRect();
const card = () => doc.querySelector<HTMLElement>("[data-floating-card]");
const sheetLabel = () => doc.querySelector(".chart-sheet-label")?.textContent ?? null;
const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
/** The gap between the first two cells, px. */
const gapPx = () => Math.round(rect(cell(1)).left - rect(cell(0)).right);

describe("weather grid: hover and pin", () => {
  it("hovering a cell shows that direction's card, and keeps it across the gap to the next", async () => {
    await mount(props({ days: 7 }));
    await userEvent.hover(cell(2, 1));
    await expect.poll(() => card()?.textContent).toContain("Bravo · cell 2");

    // Into the gap between cells 2 and 3: the grid itself, not a cell.
    const a = rect(cell(2, 1)), b = rect(cell(3, 1)), g = rect(grid());
    expect(b.left).toBeGreaterThan(a.right);
    await userEvent.hover(grid(), { position: { x: (a.right + b.left) / 2 - g.left, y: a.top + a.height / 2 - g.top } });
    expect(card()?.textContent).toContain("Bravo · cell 2");

    // Off the cells, over the direction's name: it closes.
    await userEvent.hover(doc.querySelector<HTMLElement>('[data-sector="Bravo"] > div')!);
    await expect.poll(card).toBeNull();
  });

  it("a click pins the column for every direction; the stepper walks the columns", async () => {
    await mount(props({ days: 7 }));
    await userEvent.click(cell(3, 1));
    await expect.poll(sheetLabel).toBe("Column 3");
    await expect.element(page.getByRole("region")).toMatchTextContent("column 3 · every direction");
    expect(card()).toBeNull();   // the sheet, not the hover card

    await page.getByLabelText("Next point").click();
    expect(sheetLabel()).toBe("Column 4");
  });

  it("the pinned column gets a line through its centre, from Σ to the last direction", async () => {
    await mount(props({ days: 7, progress: 3 }));
    await userEvent.click(cell(5));
    await expect.poll(sheetLabel).toBe("Column 5");
    const line = rect(doc.querySelector('[data-testid="weather-pin-line"] > div')!);
    const top = rect(doc.querySelectorAll('[data-testid="weather-count"]')[5]);
    const bottom = rect(cell(5, 1));
    expect((line.left + line.right) / 2).toBeCloseTo((bottom.left + bottom.right) / 2, 0);
    expect(line.top).toBeCloseTo(top.top, 0);
    expect(line.bottom).toBeCloseTo(bottom.bottom, 0);
  });

  // Regression: the card was a fixed box at `left: cursor`, only as wide as
  // the room left before the viewport's edge — towards the right it squeezed,
  // and its table's label column went to nothing.
  it("the hover card keeps its width and stays on screen near the right edge", async () => {
    await page.viewport(560, 800);
    await mount(props({ days: 30, forecast: true }), 528);
    for (const i of [0, 15, 26, 30]) {
      await userEvent.hover(cell(i, 1));
      await expect.poll(() => card()?.textContent).toContain(`cell ${i}`);
      const box = rect(card()!);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(560);
      const cut = [...card()!.querySelectorAll("span")].filter((e) => e.scrollWidth > e.clientWidth + 1);
      expect(cut.map((e) => e.textContent)).toEqual([]);
    }
  });
});

describe("weather grid: summary column", () => {
  it("highlights the count, not the suffix after it", async () => {
    await mount(props({ days: 7 }));
    const tail = doc.querySelector<HTMLElement>('[data-testid="weather-tail"]')!;
    expect(tail.textContent).toBe("1/7");
    const count = tail.querySelector("span")!;
    expect(count.textContent).toBe("1");
    expect(getComputedStyle(count).color).not.toBe(getComputedStyle(tail).color);
    expect(getComputedStyle(count).fontWeight).toBe("700");
  });
});

describe("weather grid: fitting the window", () => {
  it("the progress bar runs from the first column to the end of the last one it covers", async () => {
    await mount(props({ days: 24, progress: 15 }));
    const bar = rect(doc.querySelector('[data-testid="weather-progress"]')!);
    expect(bar.left).toBeCloseTo(rect(cell(0)).left, 0);
    expect(bar.right).toBeCloseTo(rect(cell(14)).right, 0);
  });

  it("drops the gaps at 61 days, the forecast column not counted", async () => {
    const at = async (days: number) => { await mount(props({ days, forecast: true }), 960); return gapPx(); };
    expect(await at(31)).toBe(2);
    expect(await at(32)).toBe(1);
    expect(await at(60)).toBe(1);
    expect(await at(61)).toBe(0);
  });

  it("drops them at 41 days below 560px", async () => {
    await page.viewport(412, 800);
    const at = async (days: number) => { await mount(props({ days }), 380); return gapPx(); };
    expect(await at(31)).toBe(2);
    expect(await at(40)).toBe(1);
    expect(await at(41)).toBe(0);
  });

  it("thins the date labels below 560px, keeping the first and the last", async () => {
    const labelsShown = () => [...doc.querySelectorAll<HTMLElement>("[role=grid] > div")]
      .filter((el) => /^d\d+$/.test(el.textContent ?? "") && shown(el)).map((el) => el.textContent);
    await mount(props({ days: 30 }));
    expect(labelsShown()).toEqual(["d0", "d5", "d10", "d15", "d20", "d25", "d29"]);
    await page.viewport(412, 800);
    await mount(props({ days: 30 }), 380);
    expect(labelsShown()).toEqual(["d0", "d10", "d20", "d29"]);
  });

  // Container queries: these go by the column's own width, so a long window
  // on a wide screen gets them as a phone does.
  it("shows the Σ numbers only in cells 14px or wider", async () => {
    const number = (col: number) => doc.querySelectorAll('[data-testid="weather-count"] .weather-count-n')[col];
    const count = (col: number) => doc.querySelectorAll('[data-testid="weather-count"]')[col];
    await mount(props({ days: 31 }));
    expect(rect(count(0)).width).toBeGreaterThanOrEqual(14);
    expect(shown(number(0))).toBe(true);
    await mount(props({ days: 60 }));
    expect(rect(count(0)).width).toBeLessThan(14);
    expect(shown(number(0))).toBe(false);
  });

  it("cuts fcst to f in a column narrower than the word", async () => {
    const rest = () => doc.querySelector(".weather-fcst-rest");
    await mount(props({ days: 7, forecast: true }));
    expect(shown(rest())).toBe(true);
    await mount(props({ days: 60, forecast: true }));
    expect(rect(cell(60)).width).toBeLessThan(24);
    expect(shown(rest())).toBe(false);
  });

  it("ends the last label at its column when the column is narrower than it", async () => {
    // The label's text: a range around the text node, not its (column-wide) box.
    const text = () => {
      const r = doc.createRange();
      r.selectNodeContents(doc.querySelector(".weather-axis-end")!);
      return r.getBoundingClientRect();
    };
    await mount(props({ days: 7, forecast: true }));
    expect(text().left).toBeCloseTo(rect(cell(6)).left, 0);   // room: starts at its column
    await mount(props({ days: 60, forecast: true }));
    expect(rect(cell(59)).width).toBeLessThan(32);
    expect(text().right).toBeLessThanOrEqual(rect(cell(59)).right + 1);
  });
});
