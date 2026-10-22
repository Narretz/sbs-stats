import { describe, expect, it } from "vitest";
import { BODY_EXCHANGES, bodyExchangeSources, bodyExchangeTotals, exchangeRatio, exchangesInWindow } from "@/data/bodyExchanges";
import type { BodyExchange } from "@/types";

const ex = (ua: number | null, ru: number | null, extra: Partial<BodyExchange> = {}): BodyExchange => ({
  date: "2025-01-01", ua_received: ua, ru_received: ru, ua_reported_by: null, ru_reported_by: null,
  chart_creamy_caprice: null, chart_creamy_caprice_discrepancy: null, status: "confirmed", sources: [], ...extra,
});

describe("bodyExchangeTotals", () => {
  it("sums each side", () => {
    expect(bodyExchangeTotals([ex(100, 10), ex(50, 5)])).toMatchObject({ exchanges: 2, toUkraine: 150, toRussia: 15, russiaUnknown: 0 });
  });

  it("counts an unknown Russian figure apart from a real 0", () => {
    const t = bodyExchangeTotals([ex(1200, 0), ex(80, null)]);
    expect(t.toRussia).toBe(0);
    expect(t.russiaUnknown).toBe(1);
  });

  it("takes the ratio only over exchanges both sides reported", () => {
    // The 80 with no Russian count must not inflate it.
    expect(bodyExchangeTotals([ex(100, 10), ex(80, null)]).ratio).toBe(10);
    expect(bodyExchangeTotals([ex(80, null)]).ratio).toBeNull();
  });
});

describe("exchangesInWindow", () => {
  const rows = ["2025-04-18", "2025-05-16", "2025-06-11", "2025-06-13", "2025-07-17"].map((date) => ex(1, 1, { date }));
  const dates = (r: BodyExchange[]) => r.map((e) => e.date);

  it("keeps every exchange of the window's calendar months", () => {
    // Two months, two of them in June: counted by month, not by row.
    expect(dates(exchangesInWindow(rows, 2, "2025-06"))).toEqual(["2025-05-16", "2025-06-11", "2025-06-13"]);
  });

  it("ends at the end month, or runs from the start with all", () => {
    expect(dates(exchangesInWindow(rows, "all", "2025-05"))).toEqual(["2025-04-18", "2025-05-16"]);
  });

  it("is empty for a window with no exchange", () => {
    expect(exchangesInWindow(rows, 3, "2025-02")).toEqual([]);
  });
});

describe("exchangeRatio", () => {
  it("divides Ukraine's count by Russia's", () => {
    expect(exchangeRatio(ex(252, 25))).toBeCloseTo(10.08);
  });

  it("has none for a one-way transfer or a missing figure", () => {
    expect(exchangeRatio(ex(1200, 0))).toBeNull();
    expect(exchangeRatio(ex(51, null))).toBeNull();
  });
});

describe("bodyExchangeSources", () => {
  it("names the outlet and what it covers", () => {
    const [s] = bodyExchangeSources(ex(1, 1, {
      sources: [{ via: "Koord_shtab (Telegram)", url: "https://t.me/Koord_shtab/1", published_at: "2025-01-01T10:00:00+00:00", covers: ["ua_received"], quote: "" }],
    }));
    expect(s).toEqual({ href: "https://t.me/Koord_shtab/1", linkText: "Koord. HQ", label: "2025-01-01 · Ukraine" });
  });
});

describe("exchanges.json", () => {
  it("is in date order, one record per day", () => {
    const dates = BODY_EXCHANGES.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("sources every figure it states", () => {
    for (const e of BODY_EXCHANGES) {
      const covered = new Set(e.sources.flatMap((s) => s.covers));
      if (e.ua_received != null) expect(covered, e.date).toContain("ua_received");
      if (e.ru_received != null) expect(covered, e.date).toContain("ru_received");
    }
  });
});
