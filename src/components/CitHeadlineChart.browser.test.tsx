import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@/styles/theme.css";
import { ChartPinProvider } from "@/hooks/ChartPinProvider";
import { RouteProvider } from "@/hooks/RouteContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { ChartSheet } from "@/components/ChartSheet";
import { CitHeadlineChart, type CitDailyBarRow } from "@/components/CitHeadlineChart";

// CIT's headline chart on its own, on the week e2e/cit-civilians uses: 5–11
// Jan 2026, no report on Wed 7, and ONE 48-hour report for Sat 10 + Sun 11 —
// drawn as one bar across both days, at the daily average. That bar is one
// entry: either half hovers the same report, at its real 48-hour figures, and
// the pinned sheet steps over it in one step. That the DB's rows arrive in
// this shape is e2e/cit-civilians.spec.ts.

function Shell({ children }: { children: ReactNode }) {
  const route = useAppRoute();
  return (
    <RouteProvider value={route}>
      <ChartPinProvider>
        <div style={{ width: 900 }}>{children}</div>
        <ChartSheet />
      </ChartPinProvider>
    </RouteProvider>
  );
}

const day = (date: string, killed: number | null, injured: number | null): CitDailyBarRow =>
  ({ date, report_date: killed == null ? null : date, window_days: 1, killed, injured });
// The weekend report: 6 killed / 40 injured over 48 hours, each day half.
const weekend = (date: string): CitDailyBarRow =>
  ({ date, report_date: "2026-01-11", window_days: 2, killed: 3, injured: 20 });
const WEEK: CitDailyBarRow[] = [
  day("2026-01-05", 2, 10), day("2026-01-06", 4, 12), day("2026-01-07", null, null),
  day("2026-01-08", 1, 8), day("2026-01-09", 3, 15), weekend("2026-01-10"), weekend("2026-01-11"),
];
const POST = { href: "https://t.me/CIT_shellings/1", linkText: "2026-01-11 20:00 Moscow", label: "the weekend's report" };
const SOURCES = new Map([["2026-01-10", [POST]], ["2026-01-11", [POST]]]);

let doc: Document = document;
async function mount() {
  const r = await render(
    <Shell>
      <CitHeadlineChart title="All civilian casualties" data={WEEK} granularity="daily" globalStats={{}} wfull sourcesByDate={SOURCES} />
    </Shell>,
  );
  doc = r.container.ownerDocument;
}

/** Every bar drawn, in DOM order: killed's, then injured's, each by x. */
async function bars(): Promise<SVGGraphicsElement[]> {
  let els: SVGGraphicsElement[] = [];
  await expect.poll(() => (els = [...doc.querySelectorAll<SVGGraphicsElement>(".recharts-bar-rectangle path")]).length).toBeGreaterThan(0);
  return els;
}
const tooltip = () => (doc.querySelector<HTMLElement>(".recharts-tooltip-wrapper")?.innerText ?? "").trim();
const sheetLabel = () => doc.querySelector(".chart-sheet-label")?.textContent ?? null;

// Pointer moves over the bar, a few px apart — on the plot, which is what
// recharts listens to: it activates its tooltip from mousemove.
async function hoverBar(bar: Element, frac: number) {
  const svg = doc.querySelector<SVGElement>("svg.recharts-surface")!;
  const s = svg.getBoundingClientRect(), b = bar.getBoundingClientRect();
  for (const dx of [-2, 0]) {
    await userEvent.hover(svg, { position: { x: b.left - s.left + b.width * frac + dx, y: b.top - s.top + b.height / 2 } });
  }
}

describe("CitHeadlineChart — the weekend report", () => {
  it("is one bar across both days, in each band", async () => {
    await mount();
    const widths = (await bars()).map((b) => b.getBBox().width);
    // Two bands × Mon, Tue, Thu, Fri and the weekend; Wed is a gap.
    expect(widths).toHaveLength(10);
    const widest = Math.max(...widths);
    expect(widest).toBeGreaterThan(Math.min(...widths) * 2);
    expect(widths.filter((w) => w === widest)).toHaveLength(2);
  });

  it("hovers as the report at its 48-hour totals, the same from either half", async () => {
    await mount();
    // Looked up afresh for each hover: recharts re-renders its bars on one.
    const wide = async () => (await bars()).reduce((a, b) => (b.getBBox().width > a.getBBox().width ? b : a));
    const tips: string[] = [];
    for (const frac of [0.2, 0.8]) {
      await hoverBar(await wide(), frac);
      await expect.poll(tooltip).toContain("2026-01-10/11");
      tips.push(tooltip());
    }
    expect(tips[0]).toBe(tips[1]);
    // The report's own figures, not the per-day average the bar is drawn at.
    expect(tips[0]).toMatch(/Total\s+46/);
    expect(tips[0]).toMatch(/Civilians injured\s+40/);
    expect(tips[0]).toMatch(/Civilians killed\s+6/);
    expect(tips[0]).toContain("One 48-hour report");
    expect(tips[0]).toContain("daily average: 3 killed, 20 injured.");
  });

  it("is one step in the pinned sheet, with its one report linked", async () => {
    await mount();
    // Killed's bars first, in x order: Mon, Tue, Thu, Fri, weekend. Pin Friday.
    const fri = (await bars())[3];
    const b = fri.getBoundingClientRect();
    await userEvent.click(fri, { position: { x: b.width / 2, y: b.height / 2 } });
    await expect.poll(sheetLabel).toBe("2026-01-09");

    await page.getByRole("button", { name: "Next point" }).click();
    expect(sheetLabel()).toBe("2026-01-10/11");
    await expect.element(page.getByRole("region")).toMatchTextContent(/Civilians killed\s*6/);
    await page.getByRole("button", { name: /Sources \(1\)/ }).click();
    expect([...doc.querySelectorAll(".chart-sheet-sources a")].map((a) => a.getAttribute("href"))).toEqual([POST.href]);

    // The weekend is the window's last entry: nowhere further, and back is Friday.
    await expect.element(page.getByRole("button", { name: "Next point" })).toBeDisabled();
    await page.getByRole("button", { name: "Previous point" }).click();
    expect(sheetLabel()).toBe("2026-01-09");
  });
});
