import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "@/styles/theme.css";
import { ChartPinProvider } from "@/hooks/ChartPinProvider";
import { RouteProvider } from "@/hooks/RouteContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { RankingContext } from "@/hooks/useRanking";
import { ChartSheet } from "@/components/ChartSheet";
import { DailyLineChart } from "@/components/DailyLineChart";
import type { Ranking } from "@/utils/barOrder";
import type { DailyDataPoint } from "@/types";

// A daily chart on a ranking page: DailyLineChart hands its series to the
// ranked bar chart, which draws the days highest (or lowest) first — today,
// still being reported, left out — and names each bar's rank in its tooltip.

function Shell({ ranking, children }: { ranking: Ranking | null; children: ReactNode }) {
  const route = useAppRoute();
  return (
    <RouteProvider value={route}>
      <ChartPinProvider>
        <RankingContext.Provider value={ranking}>
          <div style={{ width: 900 }}>{children}</div>
        </RankingContext.Provider>
        <ChartSheet />
      </ChartPinProvider>
    </RouteProvider>
  );
}

const day = (date: string, value: number | null, is_today = false): DailyDataPoint => ({ date, value, is_today });
const DATA = [
  day("2026-10-01", 30), day("2026-10-02", 90), day("2026-10-03", null),
  day("2026-10-04", 10), day("2026-10-05", 60), day("2026-10-06", 500, true),
];

async function draw(ranking: Ranking | null) {
  const r = await render(
    <Shell ranking={ranking}>
      <DailyLineChart title="Drones" data={DATA} globalMax={0} globalMedian={0} wfull />
    </Shell>,
  );
  const doc = r.container.ownerDocument;
  await expect.poll(() => doc.querySelector(".chart-card svg.recharts-surface")).not.toBeNull();
  return doc;
}

// The x-axis labels, in drawn order. recharts renders every axis's labels in
// one layer, outside the axis group, so they're told apart by their shape.
const ticks = (doc: Document) =>
  [...doc.querySelectorAll(".chart-card .recharts-cartesian-axis-tick-value")]
    .map((e) => e.textContent ?? "").filter((t) => /^\d{4}[-/]\d{2}/.test(t));

describe("DailyLineChart on a ranking page", () => {
  it("draws the days as bars, highest first, without today or a gap", async () => {
    const doc = await draw({ order: "max", limit: 10 });
    await expect.poll(() => ticks(doc)).toEqual(["2026-10-02", "2026-10-05", "2026-10-01", "2026-10-04"]);
    expect(doc.querySelector(".chart-card .recharts-line")).toBeNull();
    expect(doc.querySelector(".chart-card")!.textContent).toContain("excl. today");
  });

  it("keeps the lowest `limit` days", async () => {
    const doc = await draw({ order: "min", limit: 2 });
    await expect.poll(() => ticks(doc)).toEqual(["2026-10-04", "2026-10-01"]);
  });

  it("names a bar's rank in its tooltip", async () => {
    const doc = await draw({ order: "max", limit: 10 });
    const svg = doc.querySelector<SVGElement>(".chart-card svg.recharts-surface")!;
    const box = svg.getBoundingClientRect();
    // The second of four bands.
    await userEvent.click(svg, { position: { x: box.width * 0.4, y: box.height * 0.5 } });
    let sheet: HTMLElement | null = null;
    await expect.poll(() => (sheet = doc.querySelector<HTMLElement>(".chart-sheet[data-open]"))).not.toBeNull();
    await expect.poll(() => sheet!.innerText).toMatch(/#2 · 2026-10-05/);
  });

  it("stays a line chart in date order", async () => {
    const doc = await draw(null);
    await expect.poll(() => doc.querySelector(".chart-card .recharts-line")).not.toBeNull();
  });
});
