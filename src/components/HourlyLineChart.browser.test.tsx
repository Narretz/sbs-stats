import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@/styles/theme.css";
import { ChartPinProvider } from "@/hooks/ChartPinProvider";
import { RouteProvider } from "@/hooks/RouteContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { ChartSheet } from "@/components/ChartSheet";
import { HourlyLineChart } from "@/components/HourlyLineChart";
import type { DailyDaySeries, EodEstimate } from "@/types";
import { getKyivDateString } from "@/hooks/sqlLoader";

// The hourly overlay on its own: one line per day, synthetic readings at every
// hour so any x lands on values. Its tooltip — the per-day list and the
// header's stats — and those stats surviving into the pinned sheet. That it
// pins on its numeric x-axis on the real page is e2e/chart-pin-families.

const TITLE = "Hourly chart";

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

/** `n` days ending today — Kyiv's real today, which is how the chart picks
 *  out the day its end-of-day estimate belongs to — each read at every hour;
 *  today up to 14:00. */
function days(n: number): DailyDaySeries[] {
  const end = new Date(`${getKyivDateString()}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (n - 1 - i));
    const today = i === n - 1;
    return {
      date: d.toISOString().slice(0, 10),
      is_today: today,
      points: Array.from({ length: today ? 15 : 24 }, (_, h) => ({ hour: h, value: (h + 1) * (10 + (i % 7)) })),
    };
  });
}

let doc: Document = document;
async function mount(n: number, { data = days(n), eodSteps }: { data?: DailyDaySeries[]; eodSteps?: EodEstimate[] } = {}) {
  const r = await render(
    <Shell><HourlyLineChart title={TITLE} data={data} globalMax={0} globalMedian={0} wfull eodSteps={eodSteps} /></Shell>,
  );
  doc = r.container.ownerDocument;
}

async function svg(): Promise<SVGElement> {
  let el: SVGElement | null = null;
  await expect.poll(() => (el = doc.querySelector(".hourly-card svg.recharts-surface"))).not.toBeNull();
  return el!;
}
// recharts activates its tooltip from mousemove: sweep a few pixels so one
// lands after it has bound its handlers.
async function hoverAt(frac: number) {
  const s = await svg();
  const box = s.getBoundingClientRect();
  for (const dx of [-6, -3, 0, 3]) {
    await userEvent.hover(s, { position: { x: box.width * frac + dx, y: box.height * 0.5 } });
  }
}
const tooltip = () => doc.querySelector<HTMLElement>(".recharts-tooltip-wrapper");

describe("HourlyLineChart tooltip", () => {
  // One row per day in the window, so a 120-day window is a 120-row list. A
  // floating tooltip is positioned rather than laid out, so nothing above it
  // bounds anything — and an unbounded column-direction wrap never wraps. It
  // ran off the bottom of the window as one very long column.
  it("wraps a long window's date list into columns, inside the card", async () => {
    await mount(120);
    await hoverAt(0.5);
    const list = () => doc.querySelector<HTMLElement>('[data-testid="hourly-tooltip-days"]');
    await expect.poll(list).not.toBeNull();
    const rows = [...list()!.querySelectorAll<HTMLElement>(":scope > div > div")];
    expect(rows.length).toBeGreaterThan(100);
    expect(list()!.querySelectorAll(":scope > div").length).toBeGreaterThan(1);

    // Bounded by MAX_GRID_HEIGHT — 34vh — not by the window being tall enough.
    expect(list()!.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight * 0.34 + 1);

    // And the card is as wide as the columns it holds: a wrapping flex box's
    // max-content width measures one column in some engines, so the card was
    // sized to its header and the columns past the third hung outside it.
    const card = tooltip()!.querySelector(":scope > div")!.getBoundingClientRect();
    expect(Math.max(...rows.map((r) => r.getBoundingClientRect().right))).toBeLessThanOrEqual(card.right);
  });

  // The sheet used to skip the descriptor's header on the grounds that its
  // stepper already shows the x. That holds only while a header IS the x: the
  // hourly one also carries the current day's value and projection, the hour's
  // median across the window, and how far the day sits from it — all dropped
  // the moment the chart was pinned. Matched on the shape of the stats rather
  // than their wording, which is still being tuned.
  it("keeps the header's stats in the pinned sheet", async () => {
    const stats = /vs \d+ other days?[\s\S]*Median\s*vs med\s*Max [\d-]+\s*vs max/;
    await mount(7);
    await hoverAt(0.3);
    await expect.poll(() => tooltip()?.textContent ?? "").toMatch(stats);

    const s = await svg();
    const box = s.getBoundingClientRect();
    await userEvent.click(s, { position: { x: box.width * 0.3, y: box.height * 0.5 } });
    await expect.poll(() => doc.querySelector(".chart-sheet-label")?.textContent ?? "").toMatch(/^(00:00|\d{2}:00–\d{2}:59)$/);
    await expect.element(page.getByRole("region")).toMatchTextContent(stats);
  });
});

// Today's end-of-day estimate, one per reading: which one an hour shows is
// eodAtHour (hourlyTooltip.test.ts). This is the chart handing it the right
// hour — its x-axis runs one ahead of the DB's (position N is hour N−1) — and
// the estimate reaching the pinned sheet. The estimates themselves come from
// the hook; e2e/eod-projection checks that wiring.
describe("HourlyLineChart — today's end-of-day estimate", () => {
  it("each hour shows the estimate made at it, none where today has no reading", async () => {
    const data = days(7);
    // Today read at 00, 06, 10 and 14 only.
    data[6] = { ...data[6], points: [0, 6, 10, 14].map((hour) => ({ hour, value: (hour + 1) * 10 })) };
    const step = (h: number, fraction: number): EodEstimate =>
      ({ bucket: String(h), asOf: `${String(h).padStart(2, "0")}:00`, fraction, projected: 1000 + h });
    await mount(7, { data, eodSteps: [step(0, 0.05), step(6, 0.3), step(10, 0.5), step(14, 0.62)] });

    const s = await svg();
    const box = s.getBoundingClientRect();
    await userEvent.click(s, { position: { x: box.width * 0.5, y: box.height * 0.5 } });
    await expect.poll(() => doc.querySelector(".chart-sheet-label")?.textContent ?? "").toMatch(/:00/);
    const sheet = () => page.getByRole("region");
    const stepTo = async (hh: number) => {
      for (let i = 0; i < 30; i++) {
        const cur = Number((doc.querySelector(".chart-sheet-label")?.textContent ?? "").slice(0, 2));
        if (cur === hh) return;
        await page.getByLabelText(cur < hh ? "Next point" : "Previous point").click();
      }
      throw new Error(`could not step to ${hh}:00`);
    };

    await stepTo(10);
    await expect.element(sheet()).toMatchTextContent(/EoD est \(50% in\)\s*~1,010/);
    // No reading at 08:00, so no estimate — not 06:00's, and not the latest.
    await stepTo(8);
    await expect.element(sheet()).not.toMatchTextContent("EoD est");
    // Past the latest reading: the current estimate, made at 14:00.
    await stepTo(18);
    await expect.element(sheet()).toMatchTextContent(/EoD est \(62% in\)\s*~1,014/);
  });
});
