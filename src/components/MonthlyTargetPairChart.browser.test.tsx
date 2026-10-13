import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "@/styles/theme.css";
import { ChartPinProvider } from "@/hooks/ChartPinProvider";
import { RouteProvider } from "@/hooks/RouteContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { ChartSheet } from "@/components/ChartSheet";
import { MonthlyTargetPairChart, type MonthlyTargetPairDataPoint } from "@/components/MonthlyTargetPairChart";

// The paired monthly chart's tooltip on the month in progress. With a subset
// label the pair collapses into one row (Hit + Killed in its columns), and the
// month-end projection is a second row filling the same columns — so the
// projected killed/destroyed shows, not just the projected hit. Read off the
// pinned sheet, which renders the same descriptor as the hover card.

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

const DATA: MonthlyTargetPairDataPoint[] = [
  { date: "2026-08-01", hit_value: 1000, destroyed_value: 400 },
  { date: "2026-09-01", hit_value: 1200, destroyed_value: 500 },
  {
    date: "2026-10-01",
    hit_value: 500, hit_gap: 1050, hit_projected: 1550,
    destroyed_value: 200, destroyed_gap: 420, destroyed_projected: 620,
    projection_day: 10, projection_days_in_month: 31,
  },
];

async function pinCurrentMonth(subsetLabel?: string): Promise<HTMLElement> {
  const r = await render(
    <Shell>
      <MonthlyTargetPairChart title="Personnel Hit / Killed" data={DATA}
        primaryLabel="Hit" secondaryLabel="Killed" subsetLabel={subsetLabel} />
    </Shell>,
  );
  const doc = r.container.ownerDocument;
  let svg: SVGElement | null = null;
  await expect.poll(() => (svg = doc.querySelector<SVGElement>(".chart-card svg.recharts-surface"))).not.toBeNull();
  const box = svg!.getBoundingClientRect();
  await userEvent.click(svg!, { position: { x: box.width * 0.9, y: box.height * 0.4 } });
  let sheet: HTMLElement | null = null;
  await expect.poll(() => (sheet = doc.querySelector<HTMLElement>(".chart-sheet[data-open]"))).not.toBeNull();
  return sheet!;
}

describe("MonthlyTargetPairChart tooltip", () => {
  it("collapsed pair: the projection row carries the projected subset and its rate", async () => {
    const sheet = await pinCurrentMonth("Killed");
    await expect.poll(() => sheet.innerText).toMatch(/Projected\s+1,550\s+620\s+40\.0%/);
    expect(sheet.innerText).toMatch(/Hit\s+500\s+200\s+40\.0%/);
  });

  it("separate rows: each series carries its own projection", async () => {
    const sheet = await pinCurrentMonth(undefined);
    await expect.poll(() => sheet.innerText).toMatch(/Hit\s+500\s+1,550/);
    expect(sheet.innerText).toMatch(/Killed\s+200\s+620/);
  });
});
