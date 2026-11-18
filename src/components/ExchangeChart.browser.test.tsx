import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "@/styles/theme.css";
import { ChartPinProvider } from "@/hooks/ChartPinProvider";
import { RouteProvider } from "@/hooks/RouteContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { RankingContext } from "@/hooks/useRanking";
import { ExchangeChart } from "@/components/ExchangeChart";
import type { ExchangeRecord } from "@/types";

// An exchange chart on a ranking page: the exchanges ranked by what the chart
// draws — both sides together, or one side alone — and one with no figure for
// it left out.

function Shell({ children }: { children: ReactNode }) {
  const route = useAppRoute();
  return (
    <RouteProvider value={route}>
      <ChartPinProvider>
        <RankingContext.Provider value={{ order: "max", limit: 10 }}>
          <div style={{ width: 900 }}>{children}</div>
        </RankingContext.Provider>
      </ChartPinProvider>
    </RouteProvider>
  );
}

const ex = (date: string, ua: number | null, ru: number | null): ExchangeRecord =>
  ({ date, ua_received: ua, ru_received: ru, status: "confirmed", sources: [] });
const DATA = [
  ex("2025-01-10", 100, 10), // 110
  ex("2025-02-10", 50, 80),  // 130
  ex("2025-03-10", 120, null),
  ex("2025-04-10", null, null),
];

async function ticks(series?: "ukraine" | "russia") {
  const r = await render(
    <Shell>
      <ExchangeChart title="T" data={DATA} series={series} colors={{ ukraine: "#00f", russia: "#f00" }} sources={() => []} />
    </Shell>,
  );
  const doc = r.container.ownerDocument;
  const read = () => [...doc.querySelectorAll(".recharts-cartesian-axis-tick-value")]
    .map((e) => e.textContent ?? "").filter((t) => /^\d{4}\//.test(t));
  await expect.poll(() => read().length).toBeGreaterThan(0);
  return read();
}

describe("ExchangeChart on a ranking page", () => {
  it("ranks both sides together; an exchange neither side reported isn't one", async () => {
    expect(await ticks()).toEqual(["2025/02/10", "2025/03/10", "2025/01/10"]);
  });

  it("ranks one side by its own figure, without the exchanges it gave none for", async () => {
    expect(await ticks("russia")).toEqual(["2025/02/10", "2025/01/10"]);
  });
});
